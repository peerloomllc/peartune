// No StartOS config form for v1: the music source, the library name, and
// pairing are all done in PearTune's own dashboard (the same as on Umbrel), and
// the dashboard password is generated on first run. An empty spec keeps the
// Config page valid but empty.
import { compat, types as T } from "../deps.ts";

export const getConfig: T.ExpectedExports.getConfig = compat.getConfig({});
