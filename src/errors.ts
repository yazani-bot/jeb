import { javaHash, rotate32 } from "@r47onfire/game-math";
import { NOTHING } from "./define";
import { ErrnoCode, ErrnoDesc } from "./errno";
import { Identifier } from "./utils";
import { JebVM, pushCommand, pushData } from "./vm";
import { Continuation } from "./continuation";

/**
 * Extra options accepted when constructing a {@link JEBError}.
 */
export interface JEBErrorOptions {
    /** Sub-errors bundled into this error, e.g. several failures reported together. */
    children?: JEBError[];
    /**
     * Location of the specific call argument this error blames (see
     * {@link JEBError.paramLocation}).
     */
    paramLocation?: Location;
}

/**
 * Arbitrary extra data attached to a {@link JEBError}. The `return` key is
 * special: it holds the restart continuation that error handlers (see `with`)
 * can invoke to resume execution at the expression that caused the error.
 */
export interface JEBErrorContext {
    [x: string]: unknown;
    return?: Continuation<any>;
}

/**
 * Generic base class for an error thrown by a JEB program.
 */
export class JEBError extends Error {
    readonly children: JEBError[];
    /**
     * When set, the VM replaces the location of the innermost traceback
     * frame with this one as the traceback is attached, so the error points
     * at the specific argument that was bad instead of at the whole call.
     * Set from {@link JEBErrorOptions.paramLocation}.
     */
    public paramLocation?: Location;
    constructor(readonly code: ErrnoCode, message?: string, readonly options: ErrorOptions & JEBErrorOptions = {}, readonly context: JEBErrorContext = {}, public traceback?: StackTreeNode[]) {
        message ??= ErrnoDesc[code];
        super(message, { cause: options.cause });
        this.name = this.constructor.name;
        this.children = options.children ?? [];
        this.paramLocation = options.paramLocation;
    }
    toString(): string {
        return `[${ErrnoCode[this.code] ?? this.code}] ${this.message}${this.traceback ? `\ntraceback: ${formatStackTraceCompact(compressStackTree(this.traceback))}` : ""}${this.cause instanceof JEBError ? `\ncaused by: ${this.cause.toString()}${this.children.map(c => c.toString().split("\n").map(l => "  " + l).join("\n")).join("\n\n")}` : ""}`
    }
}

const STACKFRAME_JOINER = "<-";

/**
 * A source location, as an `[id, file]` pair; either entry may be
 * `undefined` if it is not known.
 */
export type Location = [id: number | undefined, file: number | undefined];

/**
 * Tree node representing a compressed stack trace
 */
export type StackTreeNode = Readonly<{
    leaf: false,
    count: number;
    children: StackTreeNode[];
    hash: number;
} | {
    leaf: true,
    name: Identifier | undefined;
    location: Location | undefined;
    hash: number;
}>;

/**
 * Creates a leaf stack tree node for a single call frame. The node's hash is
 * precomputed from the frame name and location so that equal frames can be
 * recognized (and folded together) by {@link compressStackTree}.
 */
export const createStackLeafNode = (name: Identifier | undefined, location: Location | undefined): StackTreeNode => {
    return {
        leaf: true,
        name,
        location,
        hash:
            javaHash(String(name))
            ^ (location
                ? rotate32(javaHash(String(location[1])), 11)
                ^ rotate32(location[0] ?? 0x103E4E, 23)
                : 0xDEADBEEF),
    };
};

/**
 * Creates an inner stack tree node representing `count` repetitions of the
 * given child frames, with its hash precomputed from the children's hashes.
 */
export const createStackInnerNode = (count: number, children: StackTreeNode[]): StackTreeNode => {
    return {
        leaf: false,
        count,
        children,
        hash: children.reduce((prev, { hash }) =>
            rotate32(prev, 17) ^ hash, 0x24354657)
    };
};

/**
 * Compresses a list of stack frames by folding each run of consecutively
 * repeating frame patterns into a single inner node (see {@link StackTreeNode}),
 * recursively, so that tracebacks of deeply recursive programs stay readable.
 */
export const compressStackTree = (nodes: StackTreeNode[]): StackTreeNode[] => {
    const len = nodes.length;
    if (len === 0) return [];

    const result: StackTreeNode[] = [];

    for (var i = 0; i < len;) {
        // Find the best repeating pattern starting at position i
        var bestLen = 1, bestCount = 1;

        // Try pattern lengths from 1 to half the remaining array
        const maxPatternLen = ((len - i) / 2) | 0;
        for (var patternLen = 1; patternLen <= maxPatternLen; patternLen++) {
            var repeatCount = 1;

            // Count how many consecutive times this pattern repeats
            while (
                i + patternLen * (repeatCount + 1) <= len &&
                patternsEqual(nodes, i, i + patternLen * repeatCount, patternLen)
            ) repeatCount++;

            // Keep the match that repeats most times (tiebreak by longer pattern)
            if (repeatCount > 1 && (repeatCount > bestCount || (repeatCount === bestCount && patternLen > bestLen))) {
                bestLen = patternLen;
                bestCount = repeatCount;
            }
        }

        if (bestCount > 1) {
            // Create a compressed node containing the repeating pattern
            result.push(createStackInnerNode(bestCount, compressStackTree(nodes.slice(i, i + bestLen))));
            i += bestLen * bestCount;
        } else {
            // No repeating pattern; recursively compress children if non-leaf
            const node = nodes[i]!;
            result.push(node.leaf ? node : createStackInnerNode(node.count, compressStackTree(node.children)));
            i++;
        }
    }
    return result;
}

/**
 * Returns a copy of the traceback in which the innermost frame's location
 * is replaced by the given one, so an error can point at the specific
 * argument that caused it instead of at the whole call (see
 * {@link JEBError.paramLocation}). Only the single innermost frame is
 * re-located: if it is folded into a compressed repeat node, that node is
 * split so the remaining repeats keep their original location.
 */
export const blameParameter = (nodes: StackTreeNode[], location: Location): StackTreeNode[] => {
    const first = nodes[0];
    if (!first) return nodes;
    const rest = nodes.slice(1);
    if (first.leaf) return [createStackLeafNode(first.name, location), ...rest];
    const blamed = createStackInnerNode(1, blameParameter(first.children, location));
    return first.count === 1
        ? [blamed, ...rest]
        : [blamed, createStackInnerNode(first.count - 1, [...first.children]), ...rest];
};

const patternsEqual = (
    nodes: StackTreeNode[],
    offset1: number,
    offset2: number,
    length: number
): boolean => {
    for (var i = 0; i < length; i++) {
        if (!nodesEqual(nodes[offset1 + i]!, nodes[offset2 + i]!)) {
            return false;
        }
    }
    return true;
}

const nodesEqual = (node1: StackTreeNode, node2: StackTreeNode) => {
    // quick compare
    if (node1.hash !== node2.hash) return false;

    // either they're equal, or hash collision
    if (node1.leaf && node2.leaf) {
        if (node1.name !== node2.name) return false;
        return locationsEqual(node1.location, node2.location);
    }
    if (!node1.leaf && !node2.leaf) {
        // For non-leaf nodes, count and structure must match
        return node1.count === node2.count && childrenEqual(node1.children, node2.children);
    }
    return false;
}

const childrenEqual = (children1: StackTreeNode[], children2: StackTreeNode[]): boolean => {
    return children1.length === children2.length
        && children1.every((child1, i) => nodesEqual(child1, children2[i]!));
}

/**
 * Whether two (possibly undefined) {@link Location}s denote the same place.
 */
export const locationsEqual = (location1: Location | undefined, location2: Location | undefined) => {
    if (!location1 || !location2) return location1 === location2;
    return location1.every((x, i) => location2[i] === x);
}


/**
 * Formats a stack tree as a compact string representation
 * @param nodes The compressed stack tree nodes
 * @returns A formatted string like "foo <- bar <- (baz * 3) <- qux"
 */
export const formatStackTraceCompact = (nodes: StackTreeNode[]): string => {
    return nodes.map(item => item.leaf ? item.name : `(${formatStackTraceCompact(item.children)} * ${item.count})`).join(STACKFRAME_JOINER);
};

/**
 * Runs the function, and if it throws an error that isn't a {@link JEBError},
 * wraps it in the given error type and re-throws it, otherwise returns the function result.
 * @param kind Kind of JEB error a thrown error causes
 * @param f The function to catch errors from
 * @example
 * ```
 * wrapThrowToError(vm, ErrnoCode.EJAVASCRIPT,
 *     () => doSomethingThatMayThrow(vm, args[0]));
 * ```
 */
export const wrapThrowToError = <T>(kind: ErrnoCode, f: () => T) => {
    try {
        return f();
    } catch (e) {
        if (e instanceof JEBError) throw e;
        throw new JEBError(kind, String(e), { cause: e });
    }
}

/**
 * Pushes the value to the VM's data stack, but only if the value is not {@link NOTHING}.
 * @param vm VM we're running in
 * @param value Value to check
 */
export const checkNothingOrPush = <T extends JebVM>(vm: T, value: any) => {
    if (value !== NOTHING) pushData(vm, value);
}

/**
 * Pauses the VM while the promise is pending, and then resumes it when it
 * resolves or rejects.
 */
export const promisifyVM = <T extends JebVM, X>(vm: T, promise: Promise<X>): typeof NOTHING => {
    vm.paused = true;
    const { promise: finish, resolve } = Promise.withResolvers<void>();
    vm.awaiting = finish;
    promise.then(
        result => (vm.paused = false, checkNothingOrPush(vm, result), resolve()),
        error => (vm.paused = false, pushCommand(vm, () => { throw error; }), resolve()));
    return NOTHING;
}
