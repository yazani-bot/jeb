import { Block } from "./block";
import { ARGUMENT_LOCATIONS } from "./doargs";
import { type HasDocstring } from "./doc";
import { ErrnoCode } from "./errno";
import { JEBError, Location } from "./errors";
import { ApplyMetadata } from "./protocol";
import { CallableSignature, LonghandArgument } from "./signature";
import { Identifier } from "./utils";
import { JebVM } from "./vm";

/**
 * Callable hack from https://stackoverflow.com/a/78553691. Subclasses of this
 * are actually instances of `Function`, so `typeof this === "function"`.
 */
export abstract class CallableClass extends class { constructor(self: object) { return self; } } {

    constructor() {
        const self = Object.setPrototypeOf(
            function (this: any, ...args: any[]) {
                if (new.target) return self.__new__(...args);
                return self.__call__(...args);
            }, new.target.prototype);
        super(self);
    }

    /**
     * Called when the object is invoked as a function (i.e. `this(...)`)
     */
    abstract __call__(...args: any[]): any;
    /**
     * Called when the object is invoked as a class constructor (i.e. `new this(...)`)
     */
    abstract __new__(...args: any[]): any;
    /**
     * "Private" kludge to prevent stuff that tests for typeof=="function" and automatically
     * `.bind()`s it to its owner from breaking.
     */
    private bind = () => this;
}


/**
 * Wrapper for a Javascript function that can be called by the JEB runtime.
 * The Javascript function has access to the VM so it can push opcodes to
 * implement more than just computation.
 */
export class JSFun<T extends JebVM, S extends CallableSignature = CallableSignature> implements HasDocstring, ApplyMetadata {
    constructor(
        /**
         * The name of the function as it should appear in a traceback.
         */
        readonly name: Identifier,
        /**
         * The declared parameter signature the runtime binds call arguments
         * against (see `doargs`).
         */
        readonly signature: S,
        /**
         * The javascript function implementation.
         *
         * If the function returns the special value {@link NOTHING}, no
         * value will be pushed as the result of the function call. Otherwise, the
         * return value is pushed (even if it's `undefined`).
         */
        readonly impl: (
            args: {
                [P in S[number]as P["name"]]: P extends LonghandArgument<any, 0> ? unknown[] : P extends LonghandArgument<any, 1> ? Record<PropertyKey, unknown> : unknown
            } & {
                [typeof ARGUMENT_LOCATIONS]: Record<S[number]["name"], Location | undefined>
            },
            vm: T,
            location: Location | undefined,
        ) => any,
        /**
         * The docstring given - should define the allowable syntax(es) of the function
         * or macro and give a description of its behavior.
         */
        readonly doc: string,
    ) { }
}

/**
 * A Fun is a callable function or macro implemented as JEB code instead of
 * a Javascript function.
 */
export class Fun<S extends CallableSignature = CallableSignature> extends CallableClass implements HasDocstring, ApplyMetadata {
    constructor(
        /**
         * Whether the function should be hidden from stack traces.
         */
        readonly isImplicit: boolean,
        /**
         * The name of the function as it should appear in a traceback. Ignored if isImplicit=true
         */
        public name: Identifier | undefined,
        /**
         * The declared parameter signature the runtime binds call arguments
         * against (see `doargs`).
         */
        readonly signature: S,
        /**
         * The body code that will be evaluated in the new scope with the argument values bound.
         */
        readonly body: Block,
        /**
         * The docstring given - should define the allowable syntax(es) of the function
         * or macro and give a description of its behavior.
         */
        readonly doc: string,
    ) { super(); }
    /**
     * The environment the function body closes over (delegates to the body's).
     */
    get closureEnv() { return this.body.closureEnv; }
    /**
     * JEB lambdas are currently not callable via javascript.
     */
    __call__(): never {
        throw new JEBError(ErrnoCode.ENOTSUP, "cannot call JEB fn");
    }
    /**
     * JEB lambda are not class constructors.
     */
    __new__(): never {
        throw new JEBError(ErrnoCode.ENOTSUP, "cannot construct from JEB fn");
    }
}
