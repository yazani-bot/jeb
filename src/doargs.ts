import { stringify } from "lib0/json";
import { Block } from "./block";
import { OP_eval } from "./builtins";
import { OP_unwrap } from "./builtins/unwrap";
import { makeOpcode, NOTHING } from "./define";
import { Env } from "./env";
import { ErrnoCode } from "./errno";
import { JEBError, Location, wrapThrowToError } from "./errors";
import { CallableSignature, Laziness, LonghandArgument, Rest } from "./signature";
import { Identifier } from "./utils";
import { JebVM, popData, pushCommand, pushData } from "./vm";
import { EmptyArg, KeywordArg, OptionArg, SplatArg } from "./wrapper";

/**
 * Key under which the finished arguments object carries the source
 * locations of its parameters (see {@link argumentLocation}): a record
 * from parameter name to the location of the outermost call made while
 * evaluating whatever filled it -- a given argument, or the parameter's
 * default expression (which is the location an `at` form heading it
 * attaches to it). Only parameters whose filling evaluation actually
 * made a located call have an entry.
 */
export const ARGUMENT_LOCATIONS: unique symbol = Symbol("jeb.argumentLocations");

/**
 * The location of the argument that filled the named parameter, as
 * recorded on the arguments object under {@link ARGUMENT_LOCATIONS}, or
 * `undefined` if that argument carried no location.
 */
export const argumentLocation = (args: Record<string, any>, param: Identifier): Location | undefined => (args as any)[ARGUMENT_LOCATIONS]?.[param];

/**
 * Builds an error blaming the named parameter: if the argument that filled
 * it carried a location (see {@link argumentLocation}), the VM points the
 * error's innermost traceback frame at that location instead of at the
 * whole call site (see {@link JEBError.paramLocation}).
 */
export const parameterError = (args: Record<string, any>, param: Identifier, code: ErrnoCode, message: string): JEBError =>
    new JEBError(code, message, { paramLocation: argumentLocation(args, param) });

/**
 * Records the given parameter locations on a finished arguments object
 * under {@link ARGUMENT_LOCATIONS}, if there are any.
 */
const attachLocations = (ao: Record<string, any>, locations: Record<Identifier, Location>): Record<string, any> => {
    if (Object.keys(locations).length > 0) (ao as any)[ARGUMENT_LOCATIONS] = locations;
    return ao;
};

/**
 * Records how a parameter's value was supplied, so that giving the same
 * parameter twice (in either form) can be reported as an error.
 */
const enum DoargsWhere {
    _BLANK,
    POSITIONAL,
    KEYWORD,
}

/**
 * Sentinel for "a required argument was not supplied", kept distinct from a
 * legitimately supplied `undefined` value.
 */
const MISSING = Symbol("MISSING");

const evalHelper = (vm: JebVM, state: DoargsState, env: Env, data: any, param?: LonghandArgument<any, any>): typeof NOTHING => {
    // Snapshot the last-call slot so the resumption can tell whether the
    // argument's evaluation made (and returned from) a call, and where
    // the outermost such call was located.
    pushCommand(vm, OP_doargs_loop, state, false, vm.lastCall);
    pushCommand(vm, OP_unwrap, ["splat", "keyword", "empty", "option"].concat(param?.flags ?? []));
    pushCommand(vm, OP_eval, undefined);
    pushData(vm, data);
    vm.currentEnv = env;
    return NOTHING;
};

const doneHelper = (vm: JebVM, ao: Record<string, any>, env: Env, locations: Record<Identifier, Location> = {}): typeof NOTHING => {
    vm.currentEnv = env;
    pushData(vm, attachLocations(ao, locations));
    return NOTHING;
};

/**
 * Immutable state of one in-progress argument-binding operation (see
 * {@link OP_doargs}). Binding happens one argument at a time and may suspend
 * to evaluate an argument or a default expression, so the whole process is
 * captured in this object: each step produces the next state (via `#update`)
 * instead of mutating in place.
 *
 * The state tracks the signature being bound (`#params`), the raw given
 * arguments (`#givenArgs`), the index of the next raw argument
 * (`#rawArgsIndex`) and of the next parameter to fill (`#paramsIndex`), the
 * arguments object accumulated so far (`#argsObj`), and which parameters have
 * already been supplied by name (`#seenByName`). `#callEnv` is the
 * environment arguments are evaluated in; `#closureEnv` is the callee's
 * closure environment, additionally visible to default expressions.
 * In `#noEvalMode`, argument values are taken as-is and lazy parameters are
 * an error.
 *
 * `#paramLocations` holds the location of the argument that filled each
 * parameter, by parameter name, as observed from the VM's last-call slot
 * when that argument's evaluation returned (see {@link ARGUMENT_LOCATIONS});
 * it is attached to the finished arguments object and used to blame
 * binding errors on the offending argument.
 */
export class DoargsState {
    readonly #name: Identifier | undefined;
    readonly #params: CallableSignature;
    readonly #argsObj: Record<string, any>;
    readonly #callEnv: Env;
    readonly #closureEnv: Env | undefined;
    readonly #noEvalMode: boolean;
    readonly #givenArgs: any[];
    readonly #rawArgsIndex: number;
    readonly #paramsIndex: number;
    readonly #seenKeyword: boolean;
    readonly #seenByName: Readonly<Record<string, DoargsWhere>>;
    readonly #paramLocations: Readonly<Record<Identifier, Location>>;

    constructor(name: Identifier | undefined, params: CallableSignature, call: Env, closure: Env | undefined, noEval: boolean, given: any[], argsObj: Record<string, any> = {}, rawArgsIndex = 0, paramsIndex = 0, seenKeyword = false, seenByName: Record<string, DoargsWhere> = {}, paramLocations: Record<Identifier, Location> = {}) {
        this.#name = name;
        this.#params = params;
        this.#callEnv = call;
        this.#closureEnv = closure;
        this.#noEvalMode = noEval;
        this.#givenArgs = given;
        this.#argsObj = argsObj;
        this.#rawArgsIndex = rawArgsIndex;
        this.#paramsIndex = paramsIndex;
        this.#seenKeyword = seenKeyword;
        this.#seenByName = seenByName;
        this.#paramLocations = paramLocations;
        for (const p of params) {
            if (p.rest === Rest.POSITIONAL) this.#argsObj[p.name] ??= [];
            else if (p.rest === Rest.KEYWORD) this.#argsObj[p.name] ??= {};
        }
    }

    /**
     * Returns the successor state with the given fields replaced; all other
     * fields carry over from this state.
     */
    #update(argsObj = this.#argsObj, seenByName = this.#seenByName, rawArgsIndex = this.#rawArgsIndex, paramsIndex = this.#paramsIndex, seenKeyword = this.#seenKeyword, paramLocations = this.#paramLocations) {
        return new DoargsState(this.#name, this.#params, this.#callEnv, this.#closureEnv, this.#noEvalMode, this.#givenArgs, argsObj, rawArgsIndex, paramsIndex, seenKeyword, seenByName, paramLocations);
    }

    /**
     * The parameter locations for the successor state, extended with the
     * given location if it is the first one observed to fill the named
     * parameter.
     */
    #locationsFor(name: Identifier, loc: Location | undefined) {
        return loc && !(name in this.#paramLocations) ? { ...this.#paramLocations, [name]: loc } : this.#paramLocations;
    }

    /**
     * Runs the function, tagging any {@link JEBError} it throws with the
     * given location (if the error does not already blame a location), so
     * binding errors point at the offending argument.
     */
    #blame<T>(f: () => T, loc: Location | undefined): T {
        try {
            return f();
        } catch (e) {
            if (loc && e instanceof JEBError && e.paramLocation === undefined) e.paramLocation = loc;
            throw e;
        }
    }

    /**
     * Drives the binding loop until it either finishes -- leaving the completed
     * arguments object on the data stack -- or suspends by pushing opcodes to
     * evaluate the next argument, in which case `OP_doargs_loop` re-enters
     * here with `first` false and the evaluated value on the data stack.
     */
    run(vm: JebVM, first: boolean, argLocation?: Location) {
        var state: DoargsState = this;
        for (; ; first = true) {
            // There are three phases to the argument processing:
            // 1. Prepare argument value.
            // 2. Optionally evaluate it if needed.
            // 3. Store the value to the arguments object.
            const argValue = first ? state.#prepareNextValue(vm) : popData(vm);
            // prepareValue returns NOTHING if it pushed opcodes to do something,
            // otherwise it returns the value as-is
            if (argValue === NOTHING) return;
            // argLocation is the location observed for this value while it
            // was being evaluated (only present on a resumption); it is
            // recorded for the parameter whether the value came from a
            // given argument or from the parameter's default expression
            const loc = first ? undefined : argLocation;
            const newState = state.#blame(() => state.#storeArgumentAndAdvance(vm, argValue, loc), loc);
            if (newState === NOTHING) return;
            state = newState;
        }
    }
    // Also prepares evaluation or handles end-of-arguments
    #prepareNextValue(vm: JebVM) {
        const paramsList = this.#params, argv = this.#givenArgs;
        const curParamIndex = this.#paramsIndex, curArgvIndex = this.#rawArgsIndex;

        if (curArgvIndex < argv.length) {
            const value = argv[curArgvIndex]!;
            const param = paramsList[curParamIndex];
            if (param && param.lazy !== Laziness.NONE) {
                // If current arg is rest lazy, slice off everything at once and wrap it
                if (param.rest === Rest.POSITIONAL) {
                    if (this.#noEvalMode) throw new JEBError(ErrnoCode.ESYNTAX, "lazy parameter not allowed here");
                    return doneHelper(vm, { ...this.#argsObj, [param.name!]: wrapLazyValue(param.lazy, argv.slice(curArgvIndex), this.#callEnv, false) }, this.#callEnv, this.#paramLocations as Record<Identifier, Location>);
                }
                if (this.#noEvalMode) throw new JEBError(ErrnoCode.ESYNTAX, "lazy parameter not allowed here");
                return wrapLazyValue(param.lazy, value, this.#callEnv, true);
            }
            return this.#noEvalMode ? value : evalHelper(vm, this, this.#callEnv, value, param);
        }

        if (curParamIndex >= paramsList.length) {
            // Done!
            return doneHelper(vm, this.#argsObj, this.#callEnv, this.#paramLocations as Record<Identifier, Location>);
        }

        const param = paramsList[curParamIndex]!;
        // Rest parameters were initialized in the constructor and collect
        // values as they arrive; there is no default to evaluate for them,
        // so report MISSING to make the store step just step over them.
        if (param.rest !== Rest.NONE) return MISSING;
        return param.required ? MISSING : evalHelper(vm, this, this.#defaultEnv(vm), param.defaultExpr, param);
    }

    #defaultEnv(vm: JebVM) {
        return this.#closureEnv ? vm.createEnv(this.#callEnv, this.#closureEnv) : vm.createEnv(this.#callEnv);
    }

    /**
     * Stores one argument value into the arguments object and returns the
     * successor state. Keyword and splat wrappers are unpacked here; everything
     * else fills the next positional parameter (or the rest parameter).
     */
    #storeArgumentAndAdvance(vm: JebVM, argValue: any, loc: Location | undefined): DoargsState | typeof NOTHING {
        const p = this.#params, I = this.#paramsIndex;
        const param = p[I]!;
        if (argValue === MISSING && (param.rest !== Rest.NONE || (this.#seenKeyword && this.#seenByName[param.name]))) {
            // Nothing to fill here: rest parameters were already
            // initialized (and possibly collected into), and keyword-given
            // parameters already have their value. Just step over it.
            return this.#update(undefined, undefined, undefined, I + 1);
        }
        if (param?.required && (argValue === MISSING || argValue instanceof EmptyArg)) {
            throw new JEBError(ErrnoCode.ERANGE, `missing required ${I > ((p.findIndex(x => x.rest === Rest.POSITIONAL) + p.length) % p.length) ? "keyword-only " : ""}parameter ${stringify(param.name)} of function ${stringify(this.#name)}`);
        }
        if (argValue instanceof KeywordArg) {
            return this.#storeKeyword(argValue.name, argValue.obj, false, 1, loc);
        }
        if (argValue instanceof SplatArg) {
            if (argValue.isKeyword) {
                const values = { ...argValue.obj }, names = Reflect.ownKeys(values);
                var state: DoargsState = this;
                const len = names.length;
                for (var i = 0; i < len; i++) {
                    const name = names[i]!, value = values[name];
                    state.#assertNotSpecial(value);
                    state = state.#storeKeyword(name, value, true, 0, loc);
                }
                return state.#update(undefined, undefined, state.#rawArgsIndex + 1);
            } else {
                const values = [...argValue.obj];
                var state: DoargsState = this;
                const len = values.length;
                for (var i = 0; i < len; i++) {
                    const value = values[i];
                    state.#assertNotSpecial(value);
                    state = state.#storePositional(value, true, 1, 0, loc);
                }
                return state.#update(undefined, undefined, state.#rawArgsIndex + 1);
            }
        }
        if (argValue instanceof EmptyArg) {
            if (param.rest !== Rest.NONE) {
                return this.#update(undefined, undefined, this.#rawArgsIndex + 1, I + 1);
            }
            return evalHelper(vm, this, this.#defaultEnv(vm), param.defaultExpr, param);
        }
        if (argValue instanceof OptionArg) {
            const valueExpr = param.options[argValue.obj];
            if (!Reflect.has(param.options, argValue.obj)) {
                throw new JEBError(ErrnoCode.ENAME, `no such option ${stringify(argValue.obj)}`);
            }
            return evalHelper(vm, this, this.#defaultEnv(vm), valueExpr, param);
        }
        if (this.#rawArgsIndex >= this.#givenArgs.length && this.#seenByName[param.name]) {
            // The given arguments are exhausted, so this value is the
            // parameter's evaluated default -- but the parameter was
            // already supplied by keyword, so discard it and move on.
            return this.#update(undefined, undefined, undefined, I + 1);
        }
        return this.#storePositional(argValue, false, 1, 1, loc);
    }
    /**
     * Throws if a splat being unpacked contains a nested keyword/splat wrapper,
     * which cannot be unpacked further.
     */
    #assertNotSpecial(value: any) {
        if (value instanceof KeywordArg || value instanceof SplatArg) {
            throw new JEBError(ErrnoCode.ENOSYS, "TODO: what happens when a keyword/splat wrapper is inside another argument wrapper?");
        }
    }

    #storeKeyword(name: Identifier, obj: any, isFromSplat: boolean, rawDelta: number, loc: Location | undefined) {
        if (!this.#params.some(x => x.rest === Rest.NONE && name === x.name)) {
            const p = this.#params.find(x => x.rest === Rest.KEYWORD);
            if (p) {
                return this.#update({ ...this.#argsObj, [p.name]: { ...this.#argsObj[p.name], [name]: obj } }, undefined, this.#rawArgsIndex + 1, undefined, undefined, this.#locationsFor(p.name, loc));
            }
            throw new JEBError(ErrnoCode.ERANGE, `unexpected ${isFromSplat ? "splat " : ""}keyword argument ${stringify(name)} to function ${stringify(this.#name)}`);
        }
        return this.#update({ ...this.#argsObj, [name]: obj }, { ...this.#seenByName, [name]: DoargsWhere.KEYWORD }, this.#rawArgsIndex + rawDelta, undefined, true, this.#locationsFor(name, loc));
    }
    #storePositional(value: any, isFromSplat: boolean, paramsDelta: number, rawDelta: number, loc: Location | undefined): DoargsState {
        if (this.#seenKeyword) {
            throw new JEBError(ErrnoCode.ESYNTAX, "positional argument can't follow keyword argument");
        }
        this.#assertNotSpecial(value);
        const pList = this.#params, index = this.#paramsIndex;
        if (index >= pList.length) {
            const p = this.#params.find(x => x.rest === Rest.POSITIONAL);
            if (p) {
                if (p.lazy !== Laziness.NONE && isFromSplat) {
                    throw new JEBError(ErrnoCode.ERANGE, "cannot unpack splat argument into lazy rest parameter");
                }
                return this.#update({ ...this.#argsObj, [p.name]: [...(this.#argsObj[p.name] ?? []), value] }, undefined, this.#rawArgsIndex + rawDelta, this.#paramsIndex + paramsDelta, undefined, this.#locationsFor(p.name, loc));
            }
            if (isFromSplat) {
                throw new JEBError(ErrnoCode.ERANGE, `too many elements in splat argument to function ${stringify(this.#name)} (at most ${pList.length - index + 1} can be passed here)`);
            } else {
                throw new JEBError(ErrnoCode.ERANGE, `too many arguments to function ${stringify(this.#name)} (expected at most ${pList.length})`);
            }
        }
        const param = pList[index]!;
        if (param.rest === Rest.POSITIONAL) {
            // The rest parameter absorbs every remaining positional value
            // without advancing the parameter index; the walk steps over
            // it once the given arguments run out.
            if (param.lazy !== Laziness.NONE && isFromSplat) {
                throw new JEBError(ErrnoCode.ERANGE, "cannot unpack splat argument into lazy rest parameter");
            }
            return this.#update({ ...this.#argsObj, [param.name]: [...(this.#argsObj[param.name] ?? []), value] }, { ...this.#seenByName, [param.name]: DoargsWhere.POSITIONAL }, this.#rawArgsIndex + rawDelta, index, undefined, this.#locationsFor(param.name, loc));
        }
        const { name, lazy } = param;
        if (lazy !== Laziness.NONE && isFromSplat) {
            throw new JEBError(ErrnoCode.ERANGE, `cannot unpack splat argument into lazy parameter ${stringify(name)} of function ${stringify(this.#name)}`);
        }
        const g = this.#seenByName[name];
        if (g) {
            throw new JEBError(ErrnoCode.ERANGE, `argument ${stringify(name)} of function ${stringify(this.#name)} already given as ${g === DoargsWhere.KEYWORD ? "keyword" : "positional"} argument`);
        }
        return this.#update({ ...this.#argsObj, [name]: value }, { ...this.#seenByName, [name]: DoargsWhere.POSITIONAL }, this.#rawArgsIndex + rawDelta, this.#paramsIndex + paramsDelta, undefined, this.#locationsFor(name, loc));
    }
}

/**
 * Applies a parameter's laziness to its unevaluated form(s): `QUOTED` passes
 * the raw form through untouched, while `LAZY` wraps it in a {@link Block}
 * (closed over the call environment) for later evaluation.
 */
const wrapLazyValue = (laziness: Laziness.LAZY | Laziness.QUOTED, given: any[], env: Env, isSingle: boolean) => {
    return laziness === Laziness.QUOTED ? given : new Block(env, isSingle ? [given] : given);
}

export const OP_doargs = makeOpcode("doargs", (vm, { 0: params, 1: env, 2: noEval, 3: name }: [CallableSignature, Env | undefined, boolean | undefined, Identifier | undefined]) => {
    const given = popData(vm);
    // Optimization: test if it's all one rest lazy parameter, just special-case that
    const first = params[0]!;
    if (params.length === 1 && first.rest !== Rest.NONE) {
        if (first.lazy !== Laziness.NONE) {
            pushData(vm, { [first.name]: wrapLazyValue(first.lazy, given, vm.currentEnv, false) });
            return;
        }
    }
    pushCommand(vm, OP_doargs_loop, new DoargsState(name, params, vm.currentEnv, env, noEval ?? false, given), true);
},
    `.imm params env
.param {CallableSignature} params - the signature of the thing being called
.param {Env?} env - the closure environment that the default parameters need
.sed argslist -- argsobj
. Processes the given arguments list into the named arguments object as determined by the signature.`);

/**
 * Companion to `OP_doargs`: resumes a suspended {@link DoargsState} after the
 * argument it was waiting on has been evaluated. Errors raised while storing
 * an argument are reported as ERANGE.
 *
 * The third immediate is the last-call slot's contents from before the
 * argument was evaluated; if the slot has changed since, the argument's
 * evaluation returned from a call, and that call's location is passed to
 * the state as the argument's location.
 */
const OP_doargs_loop = makeOpcode(null, (vm, { 0: state, 1: first, 2: lastCallBefore }) => wrapThrowToError(ErrnoCode.ERANGE, () => state.run(vm, first, !first && vm.lastCall !== lastCallBefore ? vm.lastCall?.location : undefined)), null);
