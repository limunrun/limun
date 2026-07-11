// JSON modules only ever have a `default` export — this file exists purely
// to prove that a named import from one fails to link, same as a browser.
// See examples/test.js's "import attributes" section.
import { name } from "./data.json" with { type: "json" };
export { name };
