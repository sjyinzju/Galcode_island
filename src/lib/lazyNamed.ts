import { lazy, type ComponentType, type LazyExoticComponent } from "react";

type ComponentExport<T> = T extends ComponentType<infer Props>
  ? ComponentType<Props>
  : never;

export function lazyNamed<Module, Name extends keyof Module>(
  load: () => Promise<Module>,
  name: Name,
): LazyExoticComponent<ComponentExport<Module[Name]>> {
  return lazy(async () => ({
    default: (await load())[name] as ComponentExport<Module[Name]>,
  }));
}
