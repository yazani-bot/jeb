import { JEBAuditEvents } from "../auditHookTypes";
import { Block } from "../block";
import { Fun, JSFun } from "../callable";
import { define, defineApplier, defineEvaluator, makeJSFun, makeOpcode, NOTHING } from "../define";
import { OP_doargs } from "../doargs";
import { ErrnoCode } from "../errno";
import { checkNothingOrPush, JEBError, Location } from "../errors";
import { AccessType, Reference, theTypeName, typecheck, typeOf, withType } from "../protocol";
import { CallableSignature, createSignature } from "../signature";
import { Identifier } from "../utils";
import { Command, JebVM, peekData, popData, popNData, pushCommand, pushData } from "../vm";
import { EmptyArg, KeywordArg, MacroWrapper, OptionArg, SplatArg } from "../wrapper";
import { ObjectPropertyReference, VariableReference } from "./reference";
import { OP_unwrap } from "./unwrap";

export const OP_audit = makeOpcode("audit", <T extends keyof JEBAuditEvents>(vm: JebVM, args: [name: T, arg: JEBAuditEvents[T]]) => {
    vm.emit(...args);
},
    `.imm name arg
..param {keyof JEBAuditEvents} name
..param {any} arg
. Raises an auditing event with the given argument.`);

export const B_audit = makeJSFun("audit", ["event", "param"], ({ event, param }, vm) => vm.emit(withType(event, ["string"], "event"), param),
    `.func (audit event param)
..param {keyof JEBAuditEvents} event
..param {any} param
. Raises an auditing event with the given argument.`);


// MARK: op: traceback push/pop
export const OP_tbPop = makeOpcode("tb_pop", vm => vm.popTraceback(),
    `.imm
.sed --
. Pops the top of the traceback stack, including all tailcall entries if there are some.`);
export const OP_tbPush = makeOpcode("tb_push", (vm: JebVM, { 0: func, 1: location, 2: tail }: [f: Identifier | undefined, Location | undefined, tail?: boolean]) => vm.pushTraceback(func, tail ?? false, location),
    `.imm function location tailcall
..param {string} function
..param {Location} location
..param {boolean} [tailcall=false]
. Pushes the function to the traceback stack.`);

// MARK: op: stack shuffle
export const OP_shuffle = makeOpcode("shuffle", (vm: JebVM, { 0: n, 1: indices }: [number, number[]]) => {
    const items = popNData(vm, n), len = indices.length;
    for (var i = 0; i < len; i++) {
        pushData(vm, items[indices[i]!]!);
    }
},
    `.imm count indices
..param {number} count
..param {number[]} indices
. Pops \`count\` items off the stack, and then pushes the items back on in the order defined by \`indices\`.
Examples:
* \`N/[0, 1, 2, 3, ..., N-1]\` = identity
* \`2/[1, 0]\` = swap
* \`1/[]\` = drop
* \`1/[0, 0]\` = dup
* \`N/[1, 2, 3, 4, ..., N-1, 0]\` = N-tuck`);

// MARK: eval
export const OP_eval = makeOpcode("eval", (vm: JebVM, { 0: location, 1: tail }: [Location | undefined, tail?: boolean]) => {
    const code = popData(vm);
    const p = vm.getProtocol(true, false, "eval", [code]);
    if (p) p.run(vm, [code], { tail: tail ?? false, location });
    else pushData(vm, code);
},
    `.imm location tailcall
..param {Location} location
..param {boolean?} [tailcall=false]
.sed value -- evaled
. Evaluates the top item of the stack. An array gets interpreted as a call and passed to [[jeb:apply]], an object has all its properties evaluated and reassembled, and anything else is treated as a literal and left as-is.`);
export const B_eval = makeJSFun("eval", ["arg"], ({ arg }, vm, location) => { pushData(vm, arg); pushCommand(vm, OP_eval, location); return NOTHING; },
    `.func (eval arg)
..param {code} arg
.returns {any}
. Evaluates \`arg\` in the current environment.`);

export const B_macro_wrap = makeJSFun("macro", ["code"], ({ code }) => new MacroWrapper(code),
    `.func (macro code)
..param {code} code
.pure
. Wraps the code in a special object that causes it to be evaluated using [[eval]] in the scope of where it was used and the result of the evaluation used in place of the actual code object.
This can be used to create an unhygienic syntactic macro by returning the wrapper immediately.`);

export const B_object = makeJSFun("object", [[0, "pairs"]], ({ pairs }) => {
    const len = pairs.length;
    if ((len & 1) > 0) {
        throw new JEBError(ErrnoCode.ESYNTAX, "object should have an even number of arguments");
    }
    const out = {} as Record<PropertyKey, any>;
    for (var i = 0; i < len; i += 2) {
        out[pairs[i] as PropertyKey] = pairs[i + 1];
    }
    return out;
},
    `.func (object key value [key2 value2]...)
..param {PropertyKey} key - Key for the next value
..param {any} value
..returns {Record}
..throws ESYNTAX - if there is an odd number of arguments
. Returns a new object with dynamically-evaluated keys.`)

const loadObjectEvaluator = (vm: JebVM) => defineEvaluator(vm, ["object"], (vm, { 0: code }, { location }) => {
    if (code === null) {
        pushData(vm, null);
        return;
    }
    // evaluate all the properties
    const target = {};
    pushData(vm, target);
    const keys = Reflect.ownKeys(code), len = keys.length;
    for (var i = 0; i < len; i++) {
        pushData(vm, new ObjectPropertyReference(AccessType.PROPERTY, target, keys[i]!));
        pushData(vm, code[keys[i]!]);
        pushCommand(vm, OP_shuffle, 1, []);
        pushCommand(vm, OP_set, true);
        pushCommand(vm, OP_shuffle, 2, [1, 0]);
        pushCommand(vm, OP_eval, location);
    }
},
    "Evaluates all of the property values, and then reassembles the object with the same set of keys with the evaluated values.");
const arrayEval = (vm: JebVM, code: any[], tail: boolean, location: Location | undefined) => {
    pushCommand(vm, OP_apply, code.slice(1), location, tail);
    pushCommand(vm, OP_unwrap, []);
    pushCommand(vm, OP_eval, location);
    pushData(vm, code[0]);
};
const loadOtherEvaluators = (vm: JebVM) => {
    defineEvaluator(vm, [Array], (vm, { 0: code }, { tail, location }) => {
        if (code.length > 0) {
            arrayEval(vm, code, tail, location);
        }
        else {
            throw new JEBError(ErrnoCode.EINVAL, "can't evaluate empty array", {}, { return: vm.cc() });
        }
    },
        `Calls the first item as a function.
.throws EINVAL - if the first item is not callable
.throws ERANGE - if the list is empty`);

    defineEvaluator(vm, [JSFun], (vm, { 0: f }) => pushData(vm, f),
        "Builtin functions evaluate to themselves.");

    defineEvaluator(vm, [Fun], (vm, { 0: f }) => pushData(vm, f),
        "Lambda functions evaluate to themselves.");

    defineEvaluator(vm, [Block], (vm, { 0: f }) => pushData(vm, f),
        "Implicit blocks evaluate to themselves.")
};

// MARK: apply
export const OP_apply = makeOpcode("apply", (vm: JebVM, { 0: argv, 1: location, 2: tail, 3: noEval }: [any[], location?: Location, tail?: boolean, noEval?: boolean]) => {
    const func = popData(vm);
    const applier = vm.getProtocol(true, false, "apply", [func]);
    if (!applier) {
        throw new JEBError(ErrnoCode.EINVAL, `can't call ${theTypeName(typeOf(func))}`, {}, { return: vm.cc() });
    }
    const { name, signature, closureEnv } = applier.describe(vm, func);
    if (name && !tail) pushCommand(vm, OP_tbPop);
    applier.run(vm, [func], { tail: tail ?? false, location });
    if (name) pushCommand(vm, OP_tbPush, name, location, tail);
    pushCommand(vm, OP_doargs, signature, closureEnv, noEval ?? false, name);
    pushData(vm, argv);
},
    `.imm expressions location tailcall noEval
..param {code[]} expressions
..param {Location?} location
..param {boolean?} [tailcall=false]
..param {boolean?} noEval
.sed functor -- result
.throws EINVAL - when the object is not callable
.throws ERANGE - when the argument count is wrong
. Pops the top value from the stack and calls it with the provided arguments.
The arguments expressions are expected to be unevaluated, and the signature of the thing being called will determine whether the argument given is evaluated or not.`);
export const B_atLocation = makeJSFun("at", [[true, "pos"], [true, "expr"]], ({ pos, expr }, vm) => {
    typecheck(pos, [Array], "pos");
    // Remove self frame from here
    vm.popTraceback(false); // don't drop tail call, just in case this is in tail position
    vm.popCommand(); // This will be the tb_pop pushed by apply above
    pushCommand(vm, OP_eval, pos as Location);
    return expr;
},
    `.macro (at location expr)
..param {opaque-id} location
..param {code} expr
. Equivalent to \`expr\` as a normal [[eval]]uation, but inserts the metadata of \`location\` into the stack frame to identify the call site itself instead of just the thing that was called. \`at\` frames never appear in tracebacks.`);
export const B_splat = makeJSFun("splat", ["value", ["kw", false]], ({ value, kw }) => new SplatArg(value, withType(kw, ["boolean"], "kw")),
    `.func (splat arg kw)
..param {any[] | object} arg - iterable or object to unpack
..param {boolean?} [kw=false] - whether to unpack into positional or keyword arguments
.pure
. Causes the value to unpack into keyword or positional arguments instead of being passed as a single value.`);
export const B_keyword = makeJSFun("kw", ["name", "value"], ({ name, value }) => new KeywordArg(value, withType(name, ["string"], "name")),
    `.func (kw name value)
..param {string} name - name of keyword arg to unpack into
..param {any} value
.pure
. Redirects the argument into a particular named argument slot.`);

export const B_blank = makeJSFun("blank", [], () => new EmptyArg(),
    `.func (blank)
.pure
. Forces the argument slot in which it is placed to use the default value.`);

export const B_option = makeJSFun("option", ["name"], ({ name }) => new OptionArg(withType(name, ["string"], "name")),
    `.func (option name)
..param {string} name - The name of the named option
.pure
. Uses the parameter's named value.`);

// MARK: string applier
const OP_apply_id_trampoline = makeOpcode(null, (vm: JebVM, { 0: tail, 1: location }: [boolean | undefined, Location | undefined]) => {
    const realFunc = popData(vm);
    const argsObj = popData(vm) as { _: any[] };
    pushData(vm, realFunc);
    pushCommand(vm, OP_apply, argsObj._, location, tail);
}, null);
const loadStringApplier = (vm: JebVM) => {
    defineApplier(vm, ["string", "symbol"], (vm, { 0: func }, { tail, location }) => {
        // String is a special case because normally strings evaluate to themselves
        // (not to a callable function), but if it's in head position, we implicitly look it up.
        pushCommand(vm, OP_apply_id_trampoline, tail, location);
        pushCommand(vm, OP_tbPop);
        pushCommand(vm, OP_unwrap, []);
        pushCommand(vm, OP_get, false);
        pushCommand(vm, OP_shuffle, 2, [1, 0]);
        pushCommand(vm, OP_tbPush, undefined, location);
        pushData(vm, new VariableReference(AccessType.FUNCTION, vm.currentEnv, func));
    }, () => ({
        name: undefined,
        signature: ALL_UNDERSCORE_QUOTED,
        macro: false,
    }),
        `Applying a string is shorthand for looking up the variable with the same name as the string and calling that instead.
As a consequence, \`('foo)\` is the same as \`(foo)\` in JEB even though the former would be invalid in conventional Lisp.`);
    // MARK: builtin applier
    defineApplier(vm, [JSFun],
        (vm, { 0: func }, { location }) => pushCommand(vm, OP_JSFun_invoke, func, location),
        (_, func) => func,
        "Wrapper for a Javascript function that gives it a few properties to make it easier for JEB to call it.");
};
const OP_JSFun_invoke = makeOpcode(null, <T extends JebVM>(vm: T, { 0: func, 1: location }: [JSFun<T>, loc?: Location | undefined]) => checkNothingOrPush(vm, func.impl(popData(vm), vm, location)), null);

export const OP_index = makeOpcode("index", (vm: JebVM, { 0: type }: [AccessType]) => {
    const field = popData(vm) as PropertyKey;
    const obj = popData(vm);
    const accessor = vm.getProtocol(true, false, "access", [obj]);
    if (!accessor) {
        throw new JEBError(ErrnoCode.EINVAL, `${theTypeName(typeOf(obj))} is not subscriptable`);
    }
    checkNothingOrPush(vm, accessor.run(vm, [obj], { field, type }));
},
    `.sed obj name -- lvalue
..param {code} name - evaluated
.throws EINVAL - if the object can't be indexed
. Finds an Accessor for the object and pushes the LValue for the given field.`);
export const OP_get = makeOpcode("get", (vm: JebVM, { 0: shouldBind }: [boolean]) => {
    checkNothingOrPush(vm, (popData(vm) as Reference).get(vm, shouldBind))
},
    `.imm accessType shouldBind
..param {AccessType} accessType
..param {boolean?} [shouldBind=false]
.sed lvalue -- value
. Takes an LValue on the top of the stack and unwraps it by calling its get() method.`);
export const OP_set = makeOpcode("set", (vm: JebVM, { 0: create, 1: readonly }: [create?: boolean, readonly_?: boolean]) => {
    const lvalue = popData(vm) as Reference;
    lvalue.set(vm, peekData(vm), create ?? false, readonly ?? false);
},
    `.imm accessType create readonly
..param {AccessType} accessType
..param {boolean?} [create=false]
..param {boolean?} [readonly=false]
.sed value lvalue -- value
. Takes an LValue on the top of the stack and calls the \`set()\` method with the next item in the stack as the value to set.`);

// MARK: logic
export const OP_if = makeOpcode("if", <T extends JebVM>(vm: T, { 0: then, 1: else_, 2: isAsm }: [any, any, asm?: false | undefined] | [Command<T> | null, Command<T> | null, true]) => {
    const condition = popData(vm);
    if (isAsm) {
        if (condition) { if (then) pushCommand(vm, ...then); } else if (else_) pushCommand(vm, ...else_);
    } else {
        pushData(vm, condition ? then : else_);
        pushCommand(vm, OP_eval, undefined, true);
    }
},
    `.imm then else isAsm
Pops the top stack value, and if it's truthy, evaluates \`then\`, and if it's falsy, evaluates \`else\`.
..param {false?} isAsm
..param {code | null} then
..param {code | null} else
..sed condition -- result
.imm then else isAsm
Pops the top stack value, and if it's truthy, queues \`then\` to be executed as a command, and if it's falsy queues \`else\`.
..param {true} isAsm
..param {Command | null} then
..param {Command | null} else
..sed condition -- ???`);

const ALL_UNDERSCORE_QUOTED: CallableSignature = createSignature([[0, true, "_"]]);

export const ALL_UNDERSCORE_NORMAL: CallableSignature = createSignature([[0, "_"]]);

/** Registers this file's builtins in the VM's builtins scope, in the order listed. Called by {@link loadBuiltins}. */
export const loadEvalBuiltins = (vm: JebVM) => {
    define(vm, "audit", B_audit);
    define(vm, "eval", B_eval);
    define(vm, "macro", B_macro_wrap);
    define(vm, "object", B_object);
    define(vm, "at", B_atLocation);
    define(vm, "splat", B_splat);
    define(vm, "kw", B_keyword);
    define(vm, "blank", B_blank);
    define(vm, "option", B_option);
    loadObjectEvaluator(vm);
    loadOtherEvaluators(vm);
    loadStringApplier(vm);
};
