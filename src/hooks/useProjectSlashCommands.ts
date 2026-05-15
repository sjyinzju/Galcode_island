// 拉取项目级 + 用户级斜杠命令。
//
// 每次 projectPath 变化时 invoke 一次后端 list_project_slash_commands；结果缓存到组件状态。
// 不轮询、不监听文件变化 —— 命令文件很少改，用户改完手动 focus 输入框就会重新拉。

import { useEffect, useState } from "react";
import { invoke } from "../lib/bridge";
import {
  projectMetaToRecord,
  type ProjectSlashCommandMeta,
  type SlashCommandRecord,
} from "../lib/slashCommands";

interface BackendMeta {
  name: string;
  source: "project" | "user" | "plugin";
  description: string;
  argumentHint?: string | null;
  filePath: string;
  plugin?: string | null;
}

export function useProjectSlashCommands(projectPath: string | null): SlashCommandRecord[] {
  const [commands, setCommands] = useState<SlashCommandRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    invoke<BackendMeta[]>("list_project_slash_commands", { cwd: projectPath || null })
      .then((list) => {
        if (cancelled) return;
        const records = (Array.isArray(list) ? list : []).map((m): ProjectSlashCommandMeta => ({
          name: m.name,
          source: m.source,
          description: m.description,
          argumentHint: m.argumentHint,
          filePath: m.filePath,
          plugin: m.plugin,
        }));
        setCommands(records.map(projectMetaToRecord));
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  return commands;
}
