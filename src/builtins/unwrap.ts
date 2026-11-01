import { OP_eval, OP_get, OP_tbPop, OP_tbPush } from ".";
import { defineUnwrapper, makeOpcode } from "../define";
import { ErrnoCode } from "../errno";
import { JEBError } from "../errors";
import { DropFirst } from "../utils";
import { JebVM, peekData, popData, pushCommand, pushData } from "../vm";
import { EmptyArg, MacroWrapper, OptionArg, ReferenceWrapper, Wrapper } from "../wrapper";

/**
 * Argument tuple for {@link OP_wrap}: a {@link Wrapper} subclass constructor
 * plus the extra arguments to pass to it after the value being wrapped.
 */
type WrapArg<T extends new (obj: any, ...args: any[]) => Wrapper> = [cls: T, ...extraArgs: DropFirst<ConstructorParameters<T>>];

export const OP_wrap = makeOpcode("wrap", (vm, args: WrapArg<any>) => {
    const item = popData(vm);
    const cls = args[0];
    pushData(vm, new cls(item, ...args.slice(1)));
},
    `.imm cls args...
.param {constructor function} cls - the class constructor to use - must return instance of \`Wrapper\`
.param {any} args... - the parameters to pass into the constructor after the object
.sed obj -- wrapped
. Wraps the object in the given wrapper class.`);
export const OP_unwrap = makeOpcode("unwrap", (vm, { 0: dontUnwrap }: [string[]]) => {
    const top = peekData(vm);
    if (top instanceof Wrapper && !dontUnwrap.includes(top.flag)) {
        popData(vm);
        pushCommand(vm, OP_unwrap, dontUnwrap);
        vm.getProtocol(false, true, "unwrap", [top]).run(vm, [top]);
    }
},
    `.imm dontUnwrap
.param {string[]} dontUnwrap
.sed value -- unwrapped
. Unwraps all wrappers from the value, unless the value's wrapper has a tag in the given list of \`dontUnwrap\`.`);

/**
 * Like {@link OP_unwrap}, but only unwraps {@link MacroWrapper}s, leaving
 * every other wrapper untouched. Used after evaluating a macro expansion:
 * if the expansion's value is itself a macro expansion it is expanded in
 * turn, but any other wrapper (e.g. a reference) belongs to the consumer
 * the value is ultimately headed for, whose own unwrapping -- with its
 * `dontUnwrap` flags -- decides what happens to it.
 */
const OP_unwrap_macro = makeOpcode(null, (vm) => {
    const top = peekData(vm);
    if (top instanceof MacroWrapper) {
        popData(vm);
        pushCommand(vm, OP_unwrap_macro);
        vm.getProtocol(false, true, "unwrap", [top]).run(vm, [top]);
    }
}, null);

export const loadUnwrappingBuiltins = (vm: JebVM) => {
    defineUnwrapper(vm, [ReferenceWrapper], (vm, { 0: { obj } }) => {
        pushCommand(vm, OP_get, true);
        pushData(vm, obj);
    }, "Unwraps a reference");
    defineUnwrapper(vm, [MacroWrapper], (vm, { 0: { obj } }) => {
        const from = vm.lastCall;
        if (from) {
            // The call that just returned is the one that produced this
            // expansion (normally the macro invocation itself). Evaluate
            // the expansion under a frame naming it, at its call site, so
            // that an error thrown by the expanded code mentions the macro
            // even though the macro itself has already returned. The
            // OP_unwrap_macro after the evaluation expands the expansion's
            // own result if it is itself a macro expansion, while the call
            // that produced it is still the last call, so nested expansions
            // get their own frames instead of escaping to an outer
            // consumer; any other wrapper the expansion evaluates to is
            // left for that consumer to unwrap (or not) as it sees fit.
            const frameName = from.name === undefined ? "<macro>" : `<macro ${String(from.name)}>`;
            pushCommand(vm, OP_tbPop);
            pushCommand(vm, OP_unwrap_macro);
            pushCommand(vm, OP_eval, from.location);
            pushCommand(vm, OP_tbPush, frameName, from.location, false);
        } else {
            pushCommand(vm, OP_unwrap_macro);
            pushCommand(vm, OP_eval, undefined);
        }
        pushData(vm, obj);
    }, "Unwraps a macro expansion thing");
    defineUnwrapper(vm, [EmptyArg], () => {
        throw new JEBError(ErrnoCode.EINVAL, "there is no parameter to which a default can be forced here");
    }, "Unwraps an empty arg placeholder (by throwing an error)");
    defineUnwrapper(vm, [OptionArg], () => {
        throw new JEBError(ErrnoCode.EINVAL, "there is no parameter with which an option can be used here");
    }, "Unwraps an option arg placeholder (by throwing an error)");
};
