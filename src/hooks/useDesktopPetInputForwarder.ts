import { useEffect } from "react";
import { invoke, isTauri } from "../lib/bridge";
import { listenForWindowPetInput } from "../pet/petInput";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { PetInputEvent } from "../types/pet";

let forwardQueue: Promise<void> = Promise.resolve();

function forwardInput(event: PetInputEvent): void {
  forwardQueue = forwardQueue
    .then(() => invoke<boolean>("pet_input", { event }))
    .then(() => undefined)
    .catch((error) => {
      console.warn("[pet] input forwarding failed", error);
    });
}

export function useDesktopPetInputForwarder(): void {
  const enabled = useSettingsStore((state) => state.desktopPet.enabled);

  useEffect(() => {
    if (!isTauri || !enabled) return;
    return listenForWindowPetInput(forwardInput);
  }, [enabled]);
}
