import { describe, expect, test } from "bun:test";
import { parse, stringify } from "lib0/json";
import { argumentLocation, define, ErrnoCode, float, Fun, int, JEBError, JebVM, makeJSFun, OP_shuffle, parameterError, popData, promisifyVM, pushCommand, pushData, typeMatches, withType } from "../src";
import { makeTestRun, rawTraceback, run, runAsync } from "../src/indextest";

const testTest = makeTestRun(JebVM);

describe("type matching test", () => {
    test("subclass score", () => {
        class A { }
        class B extends A { }
        class C extends B { }
        expect(typeMatches(new C(), A)).toBeLessThan(typeMatches(new C(), B));
        expect(typeMatches(new C(), A)).toBeLessThan(typeMatches(new C(), C));
        expect(typeMatches(new C(), B)).toBeLessThan(typeMatches(new C(), C));
    });
});

describe("stack machine test", () => {
    testTest(test, "identity", vm => {
        pushData(vm, 1);
        pushData(vm, 2);
        pushData(vm, 3);
        pushData(vm, 4);
        pushData(vm, 5);
        pushCommand(vm, OP_shuffle, 5, [0, 1, 2, 3, 4]);
        vm.step();
        expect(popData(vm)).toEqual(5);
        expect(popData(vm)).toEqual(4);
        expect(popData(vm)).toEqual(3);
        expect(popData(vm)).toEqual(2);
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "tuck", vm => {
        pushData(vm, 1);
        pushData(vm, 2);
        pushCommand(vm, OP_shuffle, 2, [1, 0, 1]);
        vm.step();
        expect(popData(vm)).toEqual(2);
        expect(popData(vm)).toEqual(1);
        expect(popData(vm)).toEqual(2);
    });
});

describe("basic", () => {
    testTest(test, "begin with no args returns null", vm => {
        expect(run(vm, ["begin"])).toBeTrue();
        expect(popData(vm)).toBeNull();
    });
    describe("undefined", () => {
        testTest(test, "getting variable", vm => {
            expect(() => run(vm, ["local", "nonexistent"])).toThrow('variable "nonexistent" not found');
        });
        testTest(test, "setting variable", vm => {
            expect(() => run(vm, ["set", ["local", "nonexistent"], 1])).toThrow('variable "nonexistent" not found');
        });
        testTest(test, "function", vm => {
            expect(() => run(vm, ["nonexistent"])).toThrow('function "nonexistent" not found');
        });
    });
    testTest(test, "basic commands", (vm, out) => {
        expect(run(vm, ["begin", ["print", "hi 1"], ["print", "hi 2"], ["print", "hi 3"]])).toBeTrue();
        expect(out).toEqual(["hi 1", "hi 2", "hi 3"]);
    });
    testTest(test, "basic commands wrapped in fn", (vm, out) => {
        expect(run(vm, [["fn", [], ["print", "hi 1"], ["print", "hi 2"], ["print", "hi 3"]]])).toBeTrue();
        expect(out).toEqual(["hi 1", "hi 2", "hi 3"]);
    });
    testTest(test, "get complex value", vm => {
        expect(run(vm, ["begin",
            ["define", ["x"], ["list", ["list", 1], ["list", 2], ["list", 4]]],
            ["index", ["index", ["x"], 1], 0],
        ])).toBeTrue();
        expect(popData(vm)).toBe(2);
    });
    testTest(test, "set with existing value", (vm, out) => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["print", ["set", ["local", "x"], 10]],
            ["print", ["local", "x"]],
            ["print", ["set", ["local", "x"], ["add", 1, ["local", "_"]]]],
            ["print", ["local", "x"]]
        ])).toBeTrue();
        expect(out).toEqual(["10", "10", "11", "11"]);
    });
    testTest(test, "get with computed indexing", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", ["list", 1, 2, 3]],
            ["index", ["local", "x"], ["index", ["local", "x"], 0]]
        ])).toBeTrue();
        expect(popData(vm)).toEqual(2);
    });
    testTest(test, "set with old value", (vm, out) => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["print", ["set", ["local", "x"], 10, true]],
            ["print", ["local", "x"]],
            ["print", ["set", ["local", "x"], ["add", 1, ["local", "_"]], true]],
            ["print", ["local", "x"]]
        ])).toBeTrue();
        expect(out).toEqual(["0", "10", "10", "11"]);
    });
    testTest(test, "set complex value lvalue is only evaluated once", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", "value", { x: 1 }],
            ["define", ["f"], ["print", "called"], ["local", "value"]],
            ["set", ["index", ["f"], "x"], ["add", 10, ["local", "_"]]],
            ["local", "value"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual({ x: 11 });
        expect(out).toEqual(["called"]);
    });
    testTest(test, "calling non-functions errors", vm => {
        expect(() => run(vm, [1, 2, 3])).toThrow("can't call number");
    });
    testTest(test, "math overload error", vm => {
        expect(() => run(vm, ["add", "hi", 1])).toThrow("No overload of add exists for types string, number")
    });
    testTest(test, "boolean short-circuiting", (vm, out) => {
        expect(run(vm, ["begin",
            ["or", true, ["print", "a"]],
            ["or", false, ["print", "b"]],
            ["and", 0, ["print", "a"]],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(0);
        expect(out).toEqual(["b"]);
    });
    testTest(test, "json error 1", vm => {
        try {
            parse("[");
        } catch (error: any) {
            expect(() => run(vm, ["jsonParse", "["])).toThrow(error.message);
        }
    });
    testTest(test, "json error 2", vm => {
        try {
            const x: any = [];
            x[0] = x;
            stringify(x);
        } catch (error: any) {
            expect(() => run(vm, ["begin",
                ["letIn", "x", ["list"]],
                ["set", ["index", ["local", "x"], 0], ["local", "x"]],
                ["jsonStringify", ["local", "x"]]
            ])).toThrow(error.message);
        }

    });
    testTest(test, "property chain get", vm => {
        expect(run(vm, ["begin",
            ["define", "x", { a: { b: { foo: 123 } } }],
            ["index", ["index", ["index", ["local", "x"], "a"], "b"], "foo"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(123);
    });
    testTest(test, "property chain set", vm => {
        expect(run(vm, ["begin",
            ["define", "x", { a: { b: { foo: 123 } } }],
            ["set", ["index", ["index", ["index", ["local", "x"], "a"], "b"], "foo"], ["add", ["local", "_"], 333]],
            ["local", "x"]
        ])).toBeTrue();
        expect(popData(vm)).toEqual({ a: { b: { foo: 456 } } });
    });
});

describe("tail-call elimination", () => {
    testTest(test, "command stack stays constant", vm => {
        expect(run(vm, ["begin",
            ["define", ["loop"], ["loop"]],
            ["loop"]
        ], 5000)).toBeFalse();

        // with TCO the stack never grows beyond a handful of ops
        expect(vm.recursionDepth).toBeLessThan(10);
        // traceback is a single self-referential frame + top-level begin
        expect(rawTraceback(vm)).toEqual(["loop", "begin"]);
    });

    testTest(test, "tail frames are still dropped on return", (vm, out) => {
        expect.assertions(4);
        try {
            run(vm, ["begin",
                ["define", ["foo"], ["bar"]],
                ["define", ["bar"], ["print", "hello"]],
                ["foo"],
                ["foo"],
                ["throw", ["err", "test"]]
            ]);
        } catch (err: any) {
            expect(out).toEqual(["hello", "hello"]);
            // foo and bar were tail-called, only begin and error survive
            expect(err.toString()).toContain("traceback: err<-begin");
            expect(err.toString()).not.toContain("foo");
            expect(err.toString()).not.toContain("bar");
        }

    });

    testTest(test, "non-tail frames are kept", vm => {
        expect.assertions(1);
        try {
            run(vm, ["begin",
                ["define", ["f"], ["add", 1, ["g"]]],
                ["define", ["g"], ["throw", ["err", "foo"]]],
                ["f"]
            ]);
        } catch (err: any) {
            // f -> g is NOT a tail call (it's an argument), so both stay
            expect(err.toString()).toContain("traceback: err<-g<-f<-begin");
        }
    });
});

describe("traceback compression", () => {
    testTest(test, "compresses long alternating cycle", vm => {
        expect.assertions(2);
        // a <-> b tail recursion
        expect(run(vm, ["begin",
            ["define", ["a"], ["b"]],
            ["define", ["b"], ["a"]],
            ["a"]
        ], 6000)).toBeFalse();

        // force an error to snapshot the stack
        vm.checkRecursion(0);
        try {
            while (vm.step());
        } catch (err: any) {
            // should be "(b<-a * N)" not a zillion repeats
            expect(err.toString()).toMatch(/\((b<-a|a<-b) \* \d+\)/);
        }
    });

    testTest(test, "nests cycles", vm => {
        expect.assertions(2);
        try {
            run(vm, ["begin",
                ["define", ["foo", "x"],
                    ["if", ["greater", ["local", "x"], 0],
                        ["bar", ["sub", ["local", "x"], 1]],
                        ["baz"]],
                    ["unreachable"]],
                ["define", ["bar", "x"],
                    ["foo", ["local", "x"]]],
                ["define", ["baz"],
                    ["foo", 10]],
                ["baz"],
            ]);
        } catch (err: any) {
            expect(err.toString()).toMatch(/\(if<-foo<-bar \* \d+\)/);
            expect(err.toString()).toMatch(/\([^)]*\(/);
        }
    });
});


describe("with / dynamic-wind", () => {

    const makeWith = (begin: string, end: string, ...body: any[]) => {
        return ["with", null,
            {
                enter: ["fn", ["k"],
                    ["print", begin, ["local", "k"]]],
                exit: ["fn", ["k", "err"],
                    ["print",
                        end,
                        ["local", "k"],
                        ["local", "err"]]]
            },
            ...body
        ];
    }
    testTest(test, "runs before then body then after and returns body", (vm, out) => {
        expect(run(vm, makeWith("before", "after", ["print", "body"], 123))).toBeTrue();
        expect(popData(vm)).toEqual(123);
        expect(out).toEqual(["before false", "body", "after false null"]);
    });

    testTest(test, "after runs on error", (vm, out) => {
        expect.assertions(4);
        try {
            run(vm, makeWith("before", "after", ["throw", ["err", "EINTR", "boom"]]));
        } catch (err: any) {
            expect(err).toBeDefined();
            expect(err.toString()).toContain("boom");
            expect(err.toString()).toContain("traceback: err<-with");
            expect(out).toEqual(["before false", "after false [EINTR] boom\ntraceback: err<-with"]);
        }
    });

    testTest(test, "nested with unwinds in stack order", (vm, out) => {
        expect(run(vm, makeWith("enter outer", "exit outer", makeWith("enter inner", "exit inner", null)))).toBeTrue();
        expect(out).toEqual(["enter outer false", "enter inner false", "exit inner false null", "exit outer false null"]);
    });

    testTest(test, "continuation re-enters with", (vm, out) => {
        expect(run(vm, ["begin",
            ["letIn", "k", null],
            makeWith("enter", "exit",
                [["fn", [], ["set", ["local", "k"], ["local", "return"]]]],
                ["print", "inside"]),
            ["print", "outside"],
            ["k", null],          // jump back into the with
            ["throw", ["err", "unreachable"]]
        ], 2000)).toBeFalse();

        const init = [
            "enter false",
        ];
        const repeated = [
            "inside",
            "exit false null",
            "outside",
            "enter true",
        ];
        for (var i = 0; init.length < out.length; i++, i %= repeated.length) {
            init.push(repeated[i]!);
        }
        expect(out).toEqual(init);
    });

    testTest(test, "continuation escapes with (after runs once)", (vm, out) => {
        // escape from inside with via a continuation captured outside
        expect(run(vm, ["begin",
            [["fn", [],
                makeWith("enter", "exit",
                    ["print", "inside"],
                    ["return", null],
                    ["throw", ["err", "unreachable"]])
            ]],
            ["print", "outside"]
        ])).toBeTrue();

        expect(out).toEqual(["enter false", "inside", "exit true null", "outside"]);
    });

    testTest(test, "uncaught errors retain full traceback", vm => {
        expect.assertions(1);
        try {
            run(vm, ["begin",
                ["define", ["foo"], ["throw"]],
                makeWith("", "", makeWith("", "", makeWith("", "", ["foo"])))
            ]);
        } catch (err: any) {
            expect(err.toString()).toContain("foo<-(with * 3)");
        }
    });

    testTest(test, "with requires variable name or null", vm => {
        expect(() => run(vm, ["with", { enter: null, exit: null }, false])).toThrow('expected variable name or null as first argument to "with"')
    });
    testTest(test, "with requires context object", vm => {
        expect(() => run(vm, ["with", null, null, false])).toThrow("context manager should be an object")
    });

    testTest(test, "continuation can be called with computed value", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", null],
            ["letIn", "y", [["fn", ["f"], ["f", ["local", "return"]]], ["fn", ["k"], ["set", ["local", "x"], ["local", "k"]]]]],
            ["if", ["eq", ["local", "y"], 123],
                null,
                ["x", ["add", 23, 100]]],
            ["local", "y"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(123);
    });
});

describe("metaprogramming", () => {
    testTest(test, "eval", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", "x", ["quote", ["print", ["local", "a"]]]],
            ["let", [["a", "hello"]], ["eval", ["local", "x"]]],
        ])).toBeTrue();
        expect(out).toEqual(["hello"]);
    });
    testTest(test, "user-defined macros", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["twice", [true, "x"]], ["macro", ["list", "add", ["local", "x"], ["local", "x"]]]],
            ["print", ["twice", 2]],
            ["print", ["twice", "hello"]],
            ["let", [["a", 4]], ["print", ["twice", ["begin", ["print", "arg evaluated"], ["local", "a"]]]]]
        ])).toBeTrue();
        expect(out).toEqual(["4", "hellohello", "arg evaluated", "arg evaluated", "8"]);
    });
    testTest(test, "quote/quasiquote", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", "a", 1],
            ["define", "b", 2],
            ["define", "c", 3],
            ["define", "x", ["list", 4, 5, 6]],
            ["print", ["jsonStringify", ["quote", ["foo", "bar", "baz"]]]],
            ["print", ["jsonStringify", ["quasiquote", ["foo", "bar", "baz"]]]],
            ["print", ["jsonStringify", ["quasiquote", ["foo", "bar", ["baz"]]]]],
            ["print", ["jsonStringify", ["quasiquote", ["foo", "bar", ["unquote", ["local", "a"]]]]]],
            ["print", ["jsonStringify", ["quote", ["foo", "bar", ["unquote", ["local", "a"]]]]]],
            ["print", ["jsonStringify", ["quasiquote", ["foo", "bar", ["unquote", ["local", "x"]]]]]],
            ["print", ["jsonStringify", ["quasiquote", ["foo", "bar", ["unquoteSplicing", ["local", "x"]]]]]],
            ["let", [["y", ["list", 1, 2, 3]]], ["print", ["jsonStringify", ["quasiquote", ["foo", "bar", ["unquoteSplicing", ["local", "y"]]]]]]],
        ])).toBeTrue();
        expect(out).toEqual([
            stringify(["foo", "bar", "baz"]),
            stringify(["foo", "bar", "baz"]),
            stringify(["foo", "bar", ["baz"]]),
            stringify(["foo", "bar", 1]),
            stringify(["foo", "bar", ["unquote", ["local", "a"]]]),
            stringify(["foo", "bar", [4, 5, 6]]),
            stringify(["foo", "bar", 4, 5, 6]),
            stringify(["foo", "bar", 1, 2, 3]),
        ]);
    });
    testTest(test, "bad unquote 1", vm => {
        expect(() => run(vm, ["quasiquote", ["unquote"]])).toThrow("expected 1 argument to unquote");
    });
    testTest(test, "bad unquote 2", vm => {
        expect(() => run(vm, ["unquote", 1])).toThrow("unquote not valid outside of quasiquote");
    });
    testTest(test, "bad unquoteSplicing 1", vm => {
        try {
            // @ts-expect-error
            [...1];
        } catch (e) {
            expect(() => run(vm, ["quasiquote", [["unquoteSplicing", 1], 2]])).toThrow(String(e));
        }
    });
    testTest(test, "bad unquoteSplicing 2", vm => {
        expect(() => run(vm, ["quasiquote", [["unquoteSplicing"]]])).toThrow("expected 1 argument to unquoteSplicing");
    });
    testTest(test, "bad unquoteSplicing 3", vm => {
        expect(() => run(vm, ["quasiquote", ["unquoteSplicing", 1]])).toThrow("unquoteSplicing outside of list");
    });
    testTest(test, "bad unquoteSplicing 4", vm => {
        expect(() => run(vm, ["unquoteSplicing", 1])).toThrow("unquoteSplicing not valid outside of quasiquote");
    });
});

describe("references", () => {
    testTest(test, "require deref to change", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 1],
            ["letIn", "y", ["ref", ["local", "x"]]],
            ["set", ["local", "y"], 2],
            ["local", "x"],
        ])).toBeTrue();
        expect(popData(vm)).not.toEqual(2);
    });
    testTest(test, "can be changed with deref", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 1],
            ["letIn", "y", ["ref", ["local", "x"]]],
            ["set", ["deref", ["local", "y"]], 2],
            ["local", "x"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(2);
    });
    testTest(test, "work with properties", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", { foo: 1 }],
            ["letIn", "y", ["ref", ["index", ["local", "x"], "foo"]]],
            ["set", ["deref", ["local", "y"]], 2],
            ["local", "x"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual({ foo: 2 });
    });
    testTest(test, "transparently unwrap", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", { foo: 1 }],
            ["letIn", "y", ["ref", ["index", ["local", "x"], "foo"]]],
            ["deref", ["local", "y"]],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
});

describe("reactivity", () => {
    testTest(test, "runs when a watched variable is set", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["set", ["local", "x"], 1],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "does not run on registration", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(0);
    });
    testTest(test, "only runs after registration", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["set", ["local", "x"], 1],
            ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["set", ["local", "x"], 2],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "watcher sees the new value", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "seen", 0],
            ["always", false, ["set", ["local", "seen"], ["local", "x"]], ["local", "x"]],
            ["set", ["local", "x"], 42],
            ["local", "seen"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(42);
    });
    testTest(test, "runs once per set", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["set", ["local", "x"], 1],
            ["set", ["local", "x"], 2],
            ["set", ["local", "x"], 3],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(3);
    });
    testTest(test, "runs even when set to the same value", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 1],
            ["letIn", "count", 0],
            ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["set", ["local", "x"], 1],
            ["set", ["local", "x"], 1],
            ["set", ["local", "x"], 1],
            ["set", ["local", "x"], 1],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(4);
    });
    testTest(test, "runs before the next statement", (vm, out) => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["always", false, ["print", "watcher"], ["local", "x"]],
            ["set", ["local", "x"], 1],
            ["print", "after set"],
        ])).toBeTrue();
        expect(out).toEqual(["watcher", "after set"]);
    });
    testTest(test, "does not run when an unwatched variable is set", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "y", 0],
            ["letIn", "count", 0],
            ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["set", ["local", "y"], 5],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(0);
    });
    testTest(test, "any of multiple watched variables triggers it", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "y", 0],
            ["letIn", "count", 0],
            ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"], ["local", "y"]],
            ["set", ["local", "x"], 1],
            ["set", ["local", "y"], 1],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(2);
    });
    testTest(test, "watching the same variable twice only registers it once", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"], ["local", "x"]],
            ["set", ["local", "x"], 1],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "all watchers on a variable run", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "a", 0],
            ["letIn", "b", 0],
            ["always", false, ["set", ["local", "a"], ["add", ["local", "a"], 1]], ["local", "x"]],
            ["always", false, ["set", ["local", "b"], ["add", ["local", "b"], 10]], ["local", "x"]],
            ["set", ["local", "x"], 1],
            ["list", ["local", "a"], ["local", "b"]],
        ])).toBeTrue();
        expect(popData(vm)).toEqual([1, 10]);
    });
    testTest(test, "setting through a deref'd reference triggers it", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["letIn", "rx", ["ref", ["local", "x"]]],
            ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["set", ["deref", ["local", "rx"]], 9],
            ["list", ["local", "x"], ["local", "count"]],
        ])).toBeTrue();
        expect(popData(vm)).toEqual([9, 1]);
    });
    testTest(test, "sets inside a function trigger it", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["define", ["bump"], ["set", ["local", "x"], ["add", ["local", "x"], 1]]],
            ["bump"],
            ["bump"],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(2);
    });
    testTest(test, "watchers can trigger other watchers", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "y", 0],
            ["letIn", "z", 0],
            ["always", false, ["set", ["local", "y"], ["add", ["local", "x"], 10]], ["local", "x"]],
            ["always", false, ["set", ["local", "z"], ["add", ["local", "y"], 100]], ["local", "y"]],
            ["set", ["local", "x"], 1],
            ["list", ["local", "y"], ["local", "z"]],
        ])).toBeTrue();
        expect(popData(vm)).toEqual([11, 111]);
    });
    testTest(test, "can watch a variable from a parent scope", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["let", [["f", ["fn", [], ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]]]]], ["f"]],
            ["set", ["local", "x"], 7],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "setting a shadowed variable does not trigger it", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["let", [["g", ["fn", [], ["begin", ["letIn", "x", 50], ["set", ["local", "x"], 51]]]]], ["g"]],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(0);
    });
    testTest(test, "defining a constant does not trigger it", vm => {
        expect(run(vm, ["begin",
            ["letIn", "count", 0],
            ["let", [["h", ["fn", [],
                ["letIn", "q", 1],
                ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "q"]],
                ["define", "q", 2],
            ]]], ["h"]],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(0);
    });
    testTest(test, "can watch through a deref'd stored reference", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["letIn", "rx", ["ref", ["local", "x"]]],
            ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["deref", ["local", "rx"]]],
            ["set", ["local", "x"], 1],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "property changes do not trigger it, but reassigning the variable does", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", { foo: 1 }],
            ["letIn", "count", 0],
            ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["set", ["index", ["local", "x"], "foo"], 2],
            ["set", ["local", "x"], { foo: 3 }],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "returned function cancels the watcher", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["letIn", "cancel", ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]]],
            ["set", ["local", "x"], 1],
            [["local", "cancel"]],
            ["set", ["local", "x"], 2],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "cancelling one watcher leaves the others", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "a", 0],
            ["letIn", "b", 0],
            ["letIn", "cancelA", ["always", false, ["set", ["local", "a"], ["add", ["local", "a"], 1]], ["local", "x"]]],
            ["always", false, ["set", ["local", "b"], ["add", ["local", "b"], 10]], ["local", "x"]],
            [["local", "cancelA"]],
            ["set", ["local", "x"], 1],
            ["list", ["local", "a"], ["local", "b"]],
        ])).toBeTrue();
        expect(popData(vm)).toEqual([0, 10]);
    });
    testTest(test, "cancelling a multi-variable watcher removes all of its watches", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "y", 0],
            ["letIn", "count", 0],
            ["letIn", "cancel", ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"], ["local", "y"]]],
            [["local", "cancel"]],
            ["set", ["local", "x"], 1],
            ["set", ["local", "y"], 1],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(0);
    });
    testTest(test, "cancelling twice does not error", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["letIn", "cancel", ["always", false, ["set", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]]],
            [["local", "cancel"]],
            [["local", "cancel"]],
            ["set", ["local", "x"], 1],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(0);
    });
    testTest(test, "need at least 1 variable", vm => {
        expect(() => run(vm, ["begin",
            ["always", false, ["blah"]],
        ])).toThrow("need at least 1 variable to watch");
    });
    testTest(test, "watching an undefined variable errors", vm => {
        expect(() => run(vm, ["begin",
            ["always", false, ["print", "hi"], ["local", "nope"]],
        ])).toThrow('variable "nope" not found');
    });
    testTest(test, "watching a property errors", vm => {
        expect(() => run(vm, ["begin",
            ["letIn", "x", { foo: 1 }],
            ["always", false, ["print", "hi"], ["index", ["local", "x"], "foo"]],
        ])).toThrow("can't watch this slot");
    });
    testTest(test, "watching a non-reference errors", vm => {
        expect(() => run(vm, ["begin",
            ["always", false, ["print", "hi"], 42],
        ])).toThrow("not a reference");
    });
    testTest(test, "errors in the watcher propagate", vm => {
        expect(() => run(vm, ["begin",
            ["letIn", "x", 0],
            ["always", false, ["throw", ["err", "EPANIC", "watcher blew up"]], ["local", "x"]],
            ["set", ["local", "x"], 1],
        ])).toThrow("watcher blew up");
    });
    testTest(test, "watching a constant errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", "x", 0],
            ["always", false, ["print", "hi"], ["local", "x"]],
        ])).toThrow("can't watch a constant");
    });
});

describe("keyword and splat arguments", () => {
    testTest(test, "kwargs ignore order", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["jsonStringify", ["list", ["local", "x"], ["local", "y"]]]]],
            ["pair", ["kw", "y", 2], ["kw", "x", 1]],
        ])).toBeTrue();
        expect(out).toEqual(["[1,2]"]);
    });

    testTest(test, "splat unpack into positional", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["jsonStringify", ["list", ["local", "x"], ["local", "y"]]]]],
            ["pair", ["splat", ["list", 1, 2]]],
        ])).toBeTrue();
        expect(out).toEqual(["[1,2]"]);
    });

    testTest(test, "kwarg unpack into named parameters", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["jsonStringify", ["list", ["local", "x"], ["local", "y"]]]]],
            ["pair", ["splat", { x: 1, y: 2 }, true]],
        ])).toBeTrue();
        expect(out).toEqual(["[1,2]"]);
    });

    testTest(test, "order enforced", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["jsonStringify", ["list", ["local", "x"], ["local", "y"]]]]],
            ["pair", ["kw", "x", 1], 2],
        ])).toThrow("positional argument can't follow keyword argument");
    });

    testTest(test, "missing arguments errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", "x", "y"]],
            ["foo", ["kw", "x", 1]],
        ])).toThrow('missing required parameter "y" of function "foo"');
    });

    testTest(test, "too many arguments errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", "x", "y", "z"]],
            ["foo", 1, 2, 3, 4],
        ])).toThrow('too many arguments to function "foo" (expected at most 3)');
    });

    testTest(test, "keyword-only arguments", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", [0, "x"], "y"]],
            ["foo", 1, 2, 3, 4],
        ])).toThrow('missing required keyword-only parameter "y" of function "foo"');
        vm.reset();
        expect(run(vm, ["begin",
            ["define", ["foo", [0, "x"], "y"]],
            ["foo", 1, 2, 3, 4, ["kw", "y", 5]],
        ])).toBeTrue();
    });

    testTest(test, "unpacking too many arguments errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", "x", "y", "z"]],
            ["foo", 1, 2, ["splat", ["list", 3, 4]]],
        ])).toThrow('too many elements in splat argument to function "foo" (at most 1 can be passed here)');
    });

    testTest(test, "unknown keyword arguments errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", "x"]],
            ["foo", ["kw", "y", 1]],
        ])).toThrow('unexpected keyword argument "y" to function "foo"');
    });

    testTest(test, "unknown keyword arguments via unpack errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", "x"]],
            ["foo", ["splat", { y: 1 }, true]],
        ])).toThrow('unexpected splat keyword argument "y" to function "foo"');
    });
});

describe("fns", () => {
    testTest(test, "fn optional dynamic env", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["foo", ["a", ["local", "x"]]], ["print", ["local", "a"]]],
            ["let", [["x", "hello"]], ["foo"], ["foo", "goodbye"]],
        ])).toBeTrue();
        expect(out).toEqual(["hello", "goodbye"]);
    });
    testTest(test, "spread arguments", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["foo", [0, "x"]], ["print", ["jsonStringify", ["local", "x"]]]],
            ["foo", 1, 2, 3],
            ["foo"]
        ])).toBeTrue();
        expect(out).toEqual(["[1,2,3]", "[]"]);
    });
    testTest(test, "required may follow optional", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["foo", ["x", 1], "y"], ["print", ["local", "x"], ["local", "y"]]],
            ["foo", 5, 6],
        ])).toBeTrue();
        expect(out).toEqual(["5 6"]);
        expect(() => run(vm, ["foo", 5])).toThrow('missing required parameter "y" of function "foo"');
    });
    testTest(test, "blank uses the default", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["foo", ["x", 1], "y"], ["print", ["local", "x"], ["local", "y"]]],
            ["foo", ["blank"], 6],
        ])).toBeTrue();
        expect(out).toEqual(["1 6"]);
    });
    testTest(test, "blank can't be used outside of normal args", vm => {
        expect(() => run(vm, ["begin",
            ["blank"]
        ])).toThrow("there is no parameter to which a default can be forced here");
    });
    testTest(test, "options", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["f", [{ a: "the option", b: ["local", "y"] }, "x"]], ["print", ["local", "x"]]],
            ["f", 12345],
            ["f", ["option", "a"]]
        ])).toBeTrue();
        expect(out).toEqual(["12345", "the option"]);
        expect(() => run(vm, ["begin",
            ["f", ["option", "b"]],
        ])).toThrow('variable "y" not found');
    });
    testTest(test, "options dynamic", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["f", [{ a: "the option", b: ["local", "y"] }, "x"]], ["print", ["local", "x"]]],
            ["letIn", "y", "the y value"],
            ["f", ["option", "b"]],
        ])).toBeTrue();
        expect(out).toEqual(["the y value"]);
    });
    testTest(test, "bad params", vm => {
        expect(() => run(vm, ["define", ["foo", 1], false])).toThrow("arg name not found at position 0");
    });
    testTest(test, "let loop", (vm, out) => {
        expect(run(vm, ["begin",
            ["let", "loop", [["x", 10]],
                ["print", ["local", "x"]],
                ["if", ["greater", ["local", "x"], 0],
                    ["loop", ["sub", ["local", "x"], 1]]]]
        ])).toBeTrue();
        expect(out).toEqual(["10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "0"]);
    });
    testTest(test, "bad define", vm => {
        expect(() => run(vm, ["define", 1])).toThrow("invalid define syntax")
    });
});

describe("recursion stress tests", () => {
    testTest(test, "A000142 (factorial)", vm => {
        const x = 5000n;
        const factorial = (a: bigint): bigint => a > 1 ? a * factorial(a - 1n) : 1n;
        expect(run(vm, ["begin",
            ["define", ["factorial", "a"],
                ["if", ["greater", ["local", "a"], 1],
                    ["mul", ["factorial", ["sub", ["local", "a"], 1n]], ["local", "a"]],
                    1n]],
            ["factorial", x]
        ], undefined, 10000000)).toBeTrue();
        expect(popData(vm)).toEqual(factorial(x));
    });
    const MEMOIZE_F = (f: (a: bigint) => bigint) => { const cache: Record<number, bigint> = {}; return (a: bigint) => (cache[a as any] ??= f(a)) }
    const MEMOIZE = ["define", ["memoize", "f"],
        ["let", [["cache", {}]],
            ["fn", ["a"],
                ["let", [["cached", ["index", ["local", "cache"], ["local", "a"]]]],
                    ["if", ["isNil", ["local", "cached"]],
                        ["set", ["index", ["local", "cache"], ["local", "a"]], ["f", ["local", "a"]]],
                        ["local", "cached"]]]]]
    ];
    const fibonacci = MEMOIZE_F(a => a < 2 ? a : fibonacci(a - 1n) + fibonacci(a - 2n));
    const q = MEMOIZE_F(a => a < 3 ? 1n : q(a - q(a - 1n)) + q(a - q(a - 2n)));
    const A063510 = (a: number): number => a < 2 ? 1 : 1 + A063510(a ** 0.5 | 0);
    testTest(test, "A000045 (Fibonacci sequence)", vm => {
        const x = 5000n;
        expect(run(vm, ["begin",
            MEMOIZE,
            ["define", "fibonacci", ["memoize", ["fn", ["a"],
                ["if", ["less", ["local", "a"], 2],
                    ["local", "a"],
                    ["add",
                        ["fibonacci", ["sub", ["local", "a"], 1]],
                        ["fibonacci", ["sub", ["local", "a"], 2]]]]]]],
            ["fibonacci", x]
        ], undefined, 10000000)).toBeTrue();
        expect(popData(vm)).toEqual(fibonacci(x));
    });
    testTest(test, "A005185 (Hofstadter 'Q' sequence)", vm => {
        const x = 5000n;
        expect(run(vm, ["begin",
            MEMOIZE,
            ["define", "q", ["memoize", ["fn", ["a"],
                ["if", ["less", ["local", "a"], 3],
                    1,
                    ["add",
                        ["q", ["sub", ["local", "a"], ["q", ["sub", ["local", "a"], 1]]]],
                        ["q", ["sub", ["local", "a"], ["q", ["sub", ["local", "a"], 2]]]]]]]]],
            ["q", x]
        ], undefined, 10000000)).toBeTrue();
        expect(popData(vm)).toEqual(Number(q(x)));
    });
    testTest(test, "A063510", vm => {
        const x = 1e20;
        expect(run(vm, ["begin",
            ["define", ["A063510", "a"],
                ["if", ["less", ["local", "a"], 2],
                    1,
                    ["add", 1, ["A063510", ["bitOr", 0, ["pow", ["local", "a"], 0.5]]]]]],
            ["A063510", x],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(A063510(x));
    });
    describe("unlambda", () => {
        const unlambda = (name: string, program: string, expectedOutput: string, autostop = false) => {
            testTest(test, name, vm => {
                var i = 0;
                var out: string = "";
                const next = () => program[i++];
                const parse = (): any[] => {
                    const x = next();
                    switch (x) {
                        case "`":
                            return [parse(), parse()];
                        case "s":
                        case "k":
                        case "i":
                        case "d":
                        case "c":
                        case "v":
                        case "r":
                            return ["local", x];
                        case ".":
                            return ["fn", ["x"], ["out", next()], ["local", "x"]];
                        default:
                            throw "invalid character " + x;
                    }
                }
                expect(run(vm, ["begin",
                    ["define", ["out", "c"], [(c: string) => { out += c; if (autostop && out.length === expectedOutput.length) vm.commandStack = null; }, ["local", "c"]]],
                    ["define", ["s", "x"], ["fn", ["y"], ["fn", ["z"], [["x", ["local", "z"]], ["y", ["local", "z"]]]]]],
                    ["define", ["k", "x"], ["fn", ["_"], ["local", "x"]]],
                    ["define", ["i", "x"], ["local", "x"]],
                    ["define", ["v", "x"], ["local", "v"]],
                    ["define", ["r", "x"], ["out", "\n"], ["local", "x"]],
                    ["define", ["d", [false, "x"]], ["fn", ["y"], [["x"], ["local", "y"]]]],
                    ["define", ["c", "x"], ["x", ["local", "return"]]],
                    parse(),
                ])).toBeTrue();
                expect(out).toEqual(expectedOutput);
            });
        }
        unlambda("hello world", "`````````````.H.e.l.l.o.,. .w.o.r.l.d.!i", "Hello, world!");
        unlambda("hello world 2", "`.!`.d`.l`.r``.w`. `.,``.l`c`.H.e.oi", "Hello, world!");
        unlambda("defer", "`.c``d`.bi`.ai", "abc");
        unlambda("yin-yang", "``r`ci`.*`ci", new Array(200).fill(0).map((_, i) => "*".repeat(i)).join("\n"), true);
        unlambda("fibonacci printer", "```s``s``sii`ki`k.*``s``s`ks``s`k`s`ks``s``s`ks``s`k`s`kr``s`k`sikk`k``s`ksk", new Array(20).fill(0).map((_, i) => "*".repeat(float(fibonacci(int(i))))).join("\n"), true);
    });
});

describe("FFI", () => {
    testTest(test, "FFI calling functions", (vm, out) => {
        expect(run(vm, ["begin",
            [(arg: any) => { out.push(arg, { a: 1 } as any); }, "hi"]
        ])).toBeTrue();
        expect(out).toEqual(["hi", { a: 1 } as any]);
    });
    testTest(test, "FFI get function is bound", vm => {
        expect(run(vm, ["begin",
            ["let", [["x", { a: 7, b() { return this.a * 6; } }]],
                [["index", ["local", "x"], "b"]]]
        ])).toBeTrue();
        expect(popData(vm)).toEqual(42);
    });
    testTest(test, "FFI function callbacks", (vm, out) => {
        const thrice = (f: (x: string) => void, x: string) => (f(x), f(x), f(x));
        expect(() => run(vm, ["begin",
            ["let", [["x", ["fn", ["x"], ["print", ["local", "x"]]]]],
                [thrice, ["local", "x"], "hi"],
                [thrice, ["local", "x"], "bye"]]
        ])).toThrow("cannot call JEB fn");
        // expect(out).toEqual(["hi", "hi", "hi", "bye", "bye", "bye"]);
    });
});

describe("audit hook protections", () => {
    testTest(test, "prevents accessing Function", vm => {
        vm.on("jeb:ffi/object/get", ([key, obj]) => {
            if (obj[key] === Function) {
                throw new JEBError(ErrnoCode.EACCES, "can't access that!");
            }
        });
        expect(() => run(vm, ["index", ["index", {}, "constructor"], "constructor"])).toThrow("can't access that!");
    });
    testTest(test, "infinite loop guard", vm => {
        vm.on("jeb:loop_check", count => {
            if (count > 10000) {
                throw new JEBError(ErrnoCode.EPROCLIM, "too many loops");
            }
        });
        expect(() => run(vm, [
            ["let", "loop", [], ["loop"]]
        ], 10000000)).toThrow("too many loops");
    });
});

describe("location tracking", () => {
    testTest(test, "tracks locations", vm => {
        expect.assertions(7);
        try {
            run(vm, ["at", [0, 0], ["begin",
                ["define", ["f"], ["at", [1, 0], ["g"]]],
                ["define", ["g"], ["at", [2, 0], ["h"]]],
                ["define", ["h"], ["at", [3, 0], ["error"]]],
                ["at", [4, 0], ["f"]],
            ]]);
        } catch (e2: any) {
            const e: JEBError = e2;
            expect(e).toBeInstanceOf(JEBError);
            expect(e.traceback).toBeDefined();
            expect(e.traceback!.some(e => e.leaf && e.location![0] === 0)).toBeTrue();
            expect(e.traceback!.some(e => e.leaf && e.location![0] === 1)).toBeTrue();
            expect(e.traceback!.some(e => e.leaf && e.location![0] === 2)).toBeTrue();
            expect(e.traceback!.some(e => e.leaf && e.location![0] === 3)).toBeTrue();
            expect(e.traceback!.some(e => e.leaf && e.location![0] === 4)).toBeTrue();
        }
    });
    testTest(test, "argument locations are recorded from the argument's own calls", vm => {
        define(vm, "where", makeJSFun("where", ["x"], args => argumentLocation(args, "x") ?? null, "test where"));
        expect(run(vm, ["begin",
            ["define", ["id", "x"], ["local", "x"]],
            ["where", ["at", [7, 0], ["id", 42]]],
        ])).toBeTrue();
        expect(popData(vm)).toEqual([7, 0]);
        // an argument that makes no call records no location
        expect(run(vm, ["where", 42])).toBeTrue();
        expect(popData(vm)).toBeNull();
    });
    testTest(test, "errors can blame a parameter's location", vm => {
        define(vm, "needs-string", makeJSFun("needs-string", ["x"], args => {
            if (typeof args.x !== "string") throw parameterError(args, "x", ErrnoCode.EINVAL, "x must be a string");
            return args.x;
        }, "test needs-string"));
        expect.assertions(3);
        try {
            run(vm, ["begin",
                ["define", ["id", "x"], ["local", "x"]],
                ["at", [3, 0], ["needs-string", ["at", [7, 0], ["id", 42]]]],
            ]);
        } catch (e: any) {
            expect(e.message).toBe("x must be a string");
            expect(e.paramLocation).toEqual([7, 0]);
            // the innermost frame (the needs-string call itself) points at
            // the argument's location, not the call's
            const first = e.traceback[0];
            expect(first.leaf && first.name === "needs-string" && first.location).toEqual([7, 0]);
        }
    });
    testTest(test, "binding errors blame the offending argument", vm => {
        expect.assertions(2);
        try {
            run(vm, ["begin",
                ["define", ["id", "x"], ["local", "x"]],
                ["define", ["f", "x"], ["local", "x"]],
                ["f", ["kw", "x", 1], ["at", [7, 0], ["id", 2]]],
            ]);
        } catch (e: any) {
            expect(e.message).toBe("positional argument can't follow keyword argument");
            expect(e.paramLocation).toEqual([7, 0]);
        }
    });
    testTest(test, "errors can blame a parameter whose value came from its default", vm => {
        define(vm, "needs-string", makeJSFun("needs-string", [["x", ["at", [7, 0], ["id", 42]]]], args => {
            if (typeof args.x !== "string") throw parameterError(args, "x", ErrnoCode.EINVAL, "x must be a string");
            return args.x;
        }, "test needs-string"));
        expect.assertions(3);
        try {
            run(vm, ["begin",
                ["define", ["id", "x"], ["local", "x"]],
                ["at", [3, 0], ["needs-string"]],
            ]);
        } catch (e: any) {
            expect(e.message).toBe("x must be a string");
            expect(e.paramLocation).toEqual([7, 0]);
            const first = e.traceback[0];
            expect(first.leaf && first.name === "needs-string" && first.location).toEqual([7, 0]);
        }
    });
});

testTest(test, "async test", async vm => {
    const TIME = 1000;
    const a = Date.now();
    expect(await runAsync(vm, [
        makeJSFun("wait", ["time"], ({ time }, vm) =>
            promisifyVM(vm, new Promise(resolve =>
                setTimeout(resolve, withType(time, ["number"], "time")))), ""),
        TIME])).toBeTrue();
    const b = Date.now();
    expect(Math.abs(b - a - TIME)).toBeLessThan(10);
});

testTest(test, "names stick on functions", vm => {
    expect(run(vm, ["begin",
        ["letIn", "foo", ["fn", []], "bar", null],
        ["set", ["local", "bar"], ["local", "foo"]],
        ["local", "bar"],
    ])).toBeTrue();
    const i = popData(vm);
    expect(i).toBeInstanceOf(Fun);
    expect(i.name).toEqual("foo");
});
