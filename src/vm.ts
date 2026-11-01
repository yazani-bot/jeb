import { EventDispatcher, LinkedList, LinkedList_length, LinkedList_pop, LinkedList_popN, LinkedList_push } from "@r47onfire/game-math";
import { min } from "lib0/math";
import { JEBAuditEvents } from "./auditHookTypes";
import { loadBuiltins, OP_eval, OP_throw } from "./builtins";
import { OP_unwrap } from "./builtins/unwrap";
import { Continuation, DynamicWind } from "./continuation";
import { Env } from "./env";
import { ErrnoCode } from "./errno";
import { blameParameter, createStackInnerNode, createStackLeafNode, JEBError, Location, locationsEqual, StackTreeNode } from "./errors";
import { ArgcForName, getProtocolHandler, JEBProtocols, theTypeName, typeOf } from "./protocol";
import { Identifier, Tuple } from "./utils";

/**
 * Data for the command
 */
export type Command<T extends JebVM> = [opcode: OpcodeFunction<any, T>, ...immediateArgs: any[]];
/**
 * One compressed run of call-stack frames: `count` consecutive calls of the
 * same function at the same call site, collapsed into a single traceback entry.
 */
export interface StackCount {
    /** Name of the function called, if known */
    readonly name: Identifier | undefined;
    /** Location of the call site */
    readonly location: Location | undefined;
    /** Number of frames collapsed into this entry */
    readonly count: number;
    /** Whether these frames were entered by tail calls */
    readonly tail: boolean;
}

/**
 * Function that implements an opcode for the VM by pushing instructions or pushing and popping data.
 */
export type OpcodeFunction<T extends any[], U extends JebVM> = ((vm: U, ...args: T) => void);

/**
 * Extracts the type of an opcode function's immediate arguments (everything
 * after the VM parameter), for typing calls to {@link JebVM.pushCommand}.
 */
export type GetArgParams<T extends OpcodeFunction<any, any>> = Parameters<T>[1] extends infer T extends any[] ? T : [void];

/**
 * Base VM for running JEB code
 */
export class JebVM<T extends JebVM = any> extends EventDispatcher<JEBAuditEvents> {
    /** current environment */
    currentEnv!: Env;
    /** stack of commands to execute */
    commandStack!: LinkedList<Command<T>>;
    /** stack of values */
    dataStack!: LinkedList<any>;
    /** current dynamic wind stack (linked list / tree) */
    curDynamicWind!: DynamicWind<T>;
    /** whether the VM is paused */
    paused!: boolean;
    /** the Promise that the VM is currently waiting on */
    awaiting: Promise<void> | null = null;
    /** callstack entries */
    tracebackStack!: LinkedList<StackCount>;
    /**
     * The call frame most recently popped by {@link popTraceback}: the call
     * that just returned. Only the single latest frame is kept. Consumers
     * that run immediately after a call returns (macro expansion, argument
     * binding) read this to learn which call produced the value at hand.
     */
    lastCall: StackCount | undefined = undefined;
    /** Environment that all builtins live in */
    builtinsEnv = this.createEnv();
    /** Protocol implementations registered on this VM, by protocol name */
    protocols: Partial<JEBProtocols<T>> = {};
    /** The error that stopped the VM, if any; {@link step} rethrows it while set */
    error: JEBError | undefined;
    /**
     * Hook for VM subclasses with extra state beyond the base stacks: returns a
     * snapshot of that state, so continuations and dynamic-wind can save and
     * restore it. The base VM has no extra state.
     */
    getState(): any { }
    /**
     * Counterpart to {@link getState}: restores a snapshot it returned earlier.
     */
    restoreState(state: any): void { }

    constructor() {
        super();
        this.reset();
        loadBuiltins(this as any as T);
    }
    /**
     * Registers an implementation of the named protocol. Several
     * implementations may be registered for one protocol; {@link getProtocol}
     * dispatches between them based on the argument types.
     */
    addProtocol<N extends keyof JEBProtocols<T>>(name: N, impl: JEBProtocols<T>[N][number]) {
        (this.protocols[name] ??= [] as any[]).push(impl);
    }
    /**
     * Finds the implementation of the named protocol to run for the given
     * arguments: the registered overload whose declared types best match the
     * arguments' types. With `fast`, the first matching overload (searching
     * from the most recently registered) wins instead of the best-scoring one.
     * If `assert` is true, throws when no overload matches.
     */
    getProtocol<N extends keyof JEBProtocols<T>, A extends boolean>(fast: boolean, assert: A, name: N, args: Tuple<any, ArgcForName<T, N>>): JEBProtocols<T>[N][number] | (A extends true ? never : undefined) {
        const res = getProtocolHandler(this.protocols, fast, name, args);
        if (assert && !res) throw new JEBError(ErrnoCode.ERANGE, `No overload of ${String(name)} exists for type${args.length > 1 ? "s" : ""} ${args.map(x => theTypeName(typeOf(x))).join(", ")}`);
        return res!;
    }
    /**
     * Pushes a value onto the data stack.
     */
    pushData(value: any) {
        this.dataStack = LinkedList_push(this.dataStack, value);
        // console.log("push data", value);
    }
    /**
     * Throws if the data stack holds fewer than `n` values.
     */
    #checkStack(n: number) {
        if (LinkedList_length(this.dataStack) < n) throw new JEBError(ErrnoCode.EPANIC, "data stack underflow");
    }
    /**
     * Pops the top `n` values off the data stack, returned in the order they
     * were pushed (deepest first).
     */
    popNData(n: number) {
        this.#checkStack(n);
        const { 0: values, 1: rest } = LinkedList_popN(this.dataStack!, n);
        this.dataStack = rest;
        // console.log("pop N data", values);
        return values.reverse();
    }
    /**
     * Pops and returns the top value of the data stack.
     */
    popData() {
        this.#checkStack(1);
        const { 0: value, 1: rest } = LinkedList_pop(this.dataStack!);
        this.dataStack = rest;
        // console.log("pop data", value);
        return value;
    }
    /**
     * Returns the top value of the data stack without removing it.
     */
    peekData() {
        this.#checkStack(1);
        return this.dataStack!.value;
    }
    /**
     * Pushes a command (an opcode function plus its immediate arguments) onto
     * the command stack, to be run by a later {@link step}.
     */
    pushCommand<TOpcode extends OpcodeFunction<any, T>>(f: TOpcode, ...args: GetArgParams<TOpcode>) {
        this.commandStack = LinkedList_push(this.commandStack, [f, ...args]);
    }
    /**
     * Pops and returns the next command to run. Throws if the command stack
     * is empty.
     */
    popCommand() {
        if (LinkedList_length(this.commandStack) === 0) throw new JEBError(ErrnoCode.EPANIC, "opcode stack underflow");
        const { 0: value, 1: rest } = LinkedList_pop(this.commandStack!);
        this.commandStack = rest;
        return value;
    }
    /**
     * Whether the VM has run out of commands to execute.
     */
    get done() {
        return LinkedList_length(this.commandStack) === 0;
    }
    /**
     * Runs one opcode.
     * @returns true if progress was made, false if there's nothing left to do
     * @example
     * ```ts
     * while (vm.step()); // Steps as far as possible until there's nothing left to do
     * ```
     */
    step() {
        if (this.paused || this.done) return false;
        if (this.error) throw this.error;
        const command = this.popCommand();
        try {
            command[0](this as any as T, command.slice(1));
        } catch (e) {
            if (!(e instanceof JEBError)) throw e;
            e.traceback ??= this.tracebackArray();
            if (e.paramLocation) e.traceback = blameParameter(e.traceback, e.paramLocation, e.paramName);
            this.pushCommand(OP_throw, e);
        }
        return true;
    }

    /**
     * Starts running the code
     * @param code Code to run
     * @throws if the VM is already running (i.e. there are commands on the command stack)
     */
    start(code: any) {
        if (LinkedList_length(this.commandStack) > 0) throw new Error("VM is already running");
        pushData(this as any as T, code);
        pushCommand(this as any as T, OP_unwrap, []);
        pushCommand(this as any as T, OP_eval, undefined);
    }
    /**
     * Silently stops running the code, by resetting all stacks state back to the initial empty state.
     * Does not clear the builtins env.
     */
    reset() {
        this.paused = false;
        this.commandStack = this.dataStack = this.tracebackStack = null;
        this.lastCall = undefined;
        this.currentEnv = this.createEnv(this.builtinsEnv);
        this.curDynamicWind = new DynamicWind(this as any as T);
        this.error = undefined;
    }
    /**
     * Gets the length of the command stack.
     */
    get recursionDepth() {
        return LinkedList_length(this.commandStack);
    }
    /**
     * If the {@link recursionDepth} is larger than the given length, adds an error to the command stack
     * to signal to the running program that it's recursing too much
     * @param length Maximum length before an error is added
     */
    checkRecursion(length: number) {
        if (this.recursionDepth > length) {
            this.pushCommand(OP_throw, new JEBError(ErrnoCode.EPROCLIM, "too much recursion", {}, {}, this.tracebackArray()));
        }
    }
    /**
     * Returns the names of the functions in the call stack, with innermost first
     * @returns list of stack entries, with only 1-element repeats compressed.
     */
    tracebackArray(numToDrop = 0) {
        var stack = this.tracebackStack;
        const parts: StackTreeNode[] = [];
        var prev: StackCount | undefined, prevCount = 0;
        const flush = () => {
            if (prevCount > 0) {
                const leaf = createStackLeafNode(prev!.name, prev!.location);
                parts.push(prevCount > 1 ? createStackInnerNode(prevCount, [leaf]) : leaf);
            }
            prevCount = 0;
        };
        while (stack) {
            const { name, location, count } = stack.value;
            if (prev && (prev.name !== name || prev.location !== location)) flush();
            const off = min(count, numToDrop);
            prevCount += count - off;
            numToDrop -= off;
            prev = stack.value;
            stack = stack.next;
        }
        flush();
        return parts;
    }
    /**
     * Adds a function call entry to the traceback stack
     * @param func Name of the function that is now being called
     * @param tailcallHint True if the function was tail-called
     */
    pushTraceback(func: Identifier | undefined, tailcallHint: boolean, callsiteLocation: Location | undefined) {
        const top = this.tracebackStack;
        if (top) {
            const { value: { name, tail, location, count }, next } = top;
            if (name === func && tail === tailcallHint && locationsEqual(location, callsiteLocation)) {
                // same name and type = just bump the counter
                this.tracebackStack = LinkedList_push(next, { name: func, count: count + 1, tail: tailcallHint, location: callsiteLocation });
                return;
            }
        }
        this.tracebackStack = LinkedList_push(top, { name: func, count: 1, tail: tailcallHint, location: callsiteLocation });
    }
    /**
     * Drops all the tail-call entries off the stack, and then one more
     */
    popTraceback(dropTail = true) {
        var cur = this.tracebackStack;
        if (!cur) throw new JEBError(ErrnoCode.EPANIC, "traceback stack underflow");

        // drop all TCO'ed frames
        if (dropTail) while (cur && cur.value.tail) {
            this.lastCall = cur.value;
            cur = cur.next;
        }

        if (!cur) {
            // oops, all tail calls
            this.tracebackStack = null;
            return;
        }

        this.lastCall = cur.value;

        // normal frame pop
        if (cur.value.count > 1) {
            this.tracebackStack = LinkedList_push(cur.next, { ...cur.value, count: cur.value.count - 1 });
        } else {
            this.tracebackStack = cur.next;
        }
    }
    /**
     * Creates a fresh dynamic-wind node whose parent is the VM's current node.
     */
    newDynamicWind() {
        return new DynamicWind(this as any as T);
    }
    /**
     * Creates a new environment inheriting from the given parent environments.
     */
    createEnv(...parents: Env[]) {
        return new Env({}, parents);
    }
    /**
     * Returns the current continuation at this state.
     * @param extraOps Extra opcodes to push to the command stack *when this continuation is invoked* (not now).
     */
    cc(...extraOps: Command<T>[]) {
        return new Continuation(this as any as T, extraOps);
    }
}

/**
 * Standalone form of {@link JebVM.pushData}, for opcodes (which receive the
 * VM and their arguments separately rather than as a method receiver).
 */
export const pushData = <T extends JebVM>(vm: T, data: any) => vm.pushData(data);
/**
 * Standalone form of {@link JebVM.pushCommand}; see {@link pushData}.
 */
export const pushCommand = <T extends OpcodeFunction<any, U>, U extends JebVM>(vm: U, cmd: T, ...args: GetArgParams<T>) => vm.pushCommand(cmd, ...args);
/**
 * Standalone form of {@link JebVM.popData}; see {@link pushData}.
 */
export const popData = <T extends JebVM>(vm: T) => vm.popData();
/**
 * Standalone form of {@link JebVM.popNData}; see {@link pushData}.
 */
export const popNData = <T extends JebVM>(vm: T, n: number) => vm.popNData(n);
/**
 * Standalone form of {@link JebVM.peekData}; see {@link pushData}.
 */
export const peekData = <T extends JebVM>(vm: T) => vm.peekData();
