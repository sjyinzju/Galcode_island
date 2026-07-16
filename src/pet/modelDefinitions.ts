import type { PetModelId, PetSemanticAction } from "../types/pet";

export type PetMotionFallback = "idle" | "accent" | "mirror";

export interface PetMotionDefinition {
  enter?: readonly string[];
  loop?: readonly string[];
  exit?: readonly string[];
  fallback: PetMotionFallback;
}

export interface PetModelDefinition {
  id: PetModelId;
  displayName: string;
  modelUrl: string;
  fallbackImageUrl: string;
  availableMotionGroups: readonly string[];
  motions: Record<PetSemanticAction, PetMotionDefinition>;
}

const FALLBACK_IMAGE_URL = "/50EE91C4-396A-4B96-B116-C8B7373D898B.png";
const SMILES = ["Smile0", "Smile1", "Smile2", "Smile3", "Smile4", "Smile5", "Smile6"] as const;

export const PET_MODEL_DEFINITIONS: Record<PetModelId, PetModelDefinition> = {
  haruhi: {
    id: "haruhi",
    displayName: "凉宫春日",
    modelUrl: "/models/haruhi/haruhi.model3.json",
    fallbackImageUrl: FALLBACK_IMAGE_URL,
    availableMotionGroups: [
      "hello", "hide", ...SMILES, "BlackboardIn", "BlackboardOut", "DuckIn", "DuckOut",
    ],
    motions: {
      idle: { fallback: "idle" },
      hello: { enter: ["hello"], fallback: "accent" },
      thinking: { enter: ["DuckIn"], exit: ["DuckOut"], fallback: "accent" },
      working: { enter: ["BlackboardIn"], exit: ["BlackboardOut"], fallback: "accent" },
      waiting: { enter: ["BlackboardIn"], exit: ["BlackboardOut"], fallback: "accent" },
      complete: { enter: SMILES, fallback: "accent" },
      error: { fallback: "accent" },
      poke: { enter: SMILES, fallback: "accent" },
      hide: { enter: ["hide"], fallback: "accent" },
      flip: { fallback: "mirror" },
    },
  },
  mikuru: {
    id: "mikuru",
    displayName: "朝比奈实玖瑠",
    modelUrl: "/models/mikuru/mikuru.model3.json",
    fallbackImageUrl: FALLBACK_IMAGE_URL,
    availableMotionGroups: [
      "hello", "leave", ...SMILES, "pad-in", "pad-out", "casement-in", "casement-out",
      "duck-in", "duck-out", "casement", "duck", "default",
    ],
    motions: {
      idle: { loop: ["default"], fallback: "idle" },
      hello: { enter: ["hello"], fallback: "accent" },
      thinking: { enter: ["duck-in"], loop: ["duck"], exit: ["duck-out"], fallback: "accent" },
      working: { enter: ["pad-in"], exit: ["pad-out"], fallback: "accent" },
      waiting: {
        enter: ["casement-in"],
        loop: ["casement"],
        exit: ["casement-out"],
        fallback: "accent",
      },
      complete: { enter: SMILES, fallback: "accent" },
      error: { fallback: "accent" },
      poke: { enter: ["pad-in"], exit: ["pad-out"], fallback: "accent" },
      hide: { enter: ["leave"], fallback: "accent" },
      flip: { fallback: "mirror" },
    },
  },
  yuki: {
    id: "yuki",
    displayName: "长门有希",
    modelUrl: "/models/yuki/yuki.model3.json",
    fallbackImageUrl: FALLBACK_IMAGE_URL,
    availableMotionGroups: ["hello", "hide", "waspace", "CurtainIn", "CurtainOut", "DuckIn", "DuckOut"],
    motions: {
      idle: { fallback: "idle" },
      hello: { enter: ["hello"], fallback: "accent" },
      thinking: { enter: ["DuckIn"], exit: ["DuckOut"], fallback: "accent" },
      working: { enter: ["waspace"], fallback: "accent" },
      waiting: { enter: ["CurtainIn"], exit: ["CurtainOut"], fallback: "accent" },
      complete: { enter: ["waspace"], fallback: "accent" },
      error: { fallback: "accent" },
      poke: { enter: ["hello"], fallback: "accent" },
      hide: { enter: ["hide"], fallback: "accent" },
      flip: { fallback: "mirror" },
    },
  },
};
