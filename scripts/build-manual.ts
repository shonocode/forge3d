/**
 * Write MANUAL.html from the guide data (src/app/guide/manual.ts).
 *
 *   npm run manual
 *
 * manual.test.ts fails when the committed file is out of date.
 */
import { writeFileSync } from "node:fs";
import { renderManual } from "../src/app/guide/manual.ts";

writeFileSync(new URL("../MANUAL.html", import.meta.url), renderManual());
console.log("MANUAL.html written");
