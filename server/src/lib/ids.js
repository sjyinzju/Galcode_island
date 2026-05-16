import { randomUUID } from "node:crypto";

export function newId() {
  return randomUUID();
}
