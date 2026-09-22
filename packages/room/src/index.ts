export { DEFAULT_OPTIONS, ROOM_THREAD_ID, RoomEngine, type ApplyResult, type EngineOptions, type OpContext } from "./engine.ts";
export { hunksOverlap, matchesAny, matchesPattern, patternBase, patternsOverlap } from "./paths.ts";
export {
  COLLECTIONS,
  emptyState,
  keyOf,
  snapshotOf,
  stateFromSnapshot,
  type Change,
  type Collection,
  type CollectionTypes,
  type RoomState,
} from "./state.ts";
export { computeCollisions, computeStatus, type Collision } from "./status.ts";
export { applyEvent, RoomMirror, SeqGapError, type MirrorOptions } from "./mirror.ts";
