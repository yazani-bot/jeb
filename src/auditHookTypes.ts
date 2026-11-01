import type { JebVM } from "./vm";
/**
 * Map of the audit events a {@link JebVM} can emit through its event
 * dispatcher, from event name to payload type. These events mark operations
 * that are potentially unsafe or reach outside the sandbox (host-language
 * interop), so an embedding application can hook, log, or veto them.
 * Additional events may be registered by index signature.
 */
export interface JEBAuditEvents {
    [x: string]: unknown;
    // potentially unsafe things
    "jeb:add_audit_hook": void;
    "jeb:ffi/call_function": [f: Function, args: any[]];
    "jeb:ffi/object/get": [key: PropertyKey, o: any];
    "jeb:ffi/object/set": [key: PropertyKey, o: any, value: any];
    // "jeb:ffi/object/del": [key: PropertyKey, o: any];
    "jeb:loop_check": number;
}
