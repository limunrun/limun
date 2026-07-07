import { greet } from "./greet.js";
import { foo } from "foo";

console.log(greet("modules"));
console.log(foo());
console.log(Limun.hello("Shiba"));


const desc = (obj, name) => {
  const d = Object.getOwnPropertyDescriptor(obj, name);
  return d ? d.enumerable : "missing";
};

console.assert(self === globalThis, "self === globalThis");
console.assert(desc(globalThis, "console") === false, "console should be non-enumerable");
console.assert(desc(globalThis, "Limun") === false, "Limun should be non-enumerable");
console.assert(!Object.keys(globalThis).includes("console"), "console should NOT be in Object.keys");
console.assert(Object.getOwnPropertyNames(globalThis).includes("console"), "console should be in getOwnPropertyNames");
console.assert(Object.keys(globalThis).includes("self"), "self should be in Object.keys");
console.assert(Object.getOwnPropertyNames(globalThis).includes("self"), "self should be in getOwnPropertyNames");
console.assert(globalThis.constructor.name === "Object", "globalThis.constructor.name should be Object");

while (!confirm("Exit?")) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
}