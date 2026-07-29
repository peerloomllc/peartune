import { LangDict } from './default'

// The probe is a throwaway diagnostic, so it ships English only rather than carrying
// half-accurate translations. The scaffold's Spanish stub described a hello-world
// service and would have been wrong for every string here.
export default {} satisfies Record<string, LangDict>
