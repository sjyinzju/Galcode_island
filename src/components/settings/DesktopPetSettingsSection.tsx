import { clampPetScale } from "../../pet/protocol";
import { useSettingsStore } from "../../stores/useSettingsStore";
import type { PetModelId } from "../../types/pet";

const MODEL_OPTIONS: ReadonlyArray<{ id: PetModelId; label: string }> = [
  { id: "haruhi", label: "凉宫春日" },
  { id: "mikuru", label: "朝比奈实玖瑠" },
  { id: "yuki", label: "长门有希" },
];

interface ToggleRowProps {
  checked: boolean;
  description: string;
  label: string;
  onChange: (checked: boolean) => void;
}

function ToggleRow({ checked, description, label, onChange }: ToggleRowProps): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-black/5 bg-white/30 p-3 dark:border-white/5 dark:bg-slate-800/30">
      <div className="min-w-0">
        <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{label}</div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          {description}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-sky-500" : "bg-zinc-300 dark:bg-zinc-600"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-[18px]" : "translate-x-1"
          }`}
        />
      </button>
    </div>
  );
}

export function DesktopPetSettingsSection(): JSX.Element {
  const desktopPet = useSettingsStore((state) => state.desktopPet);
  const setDesktopPetSettings = useSettingsStore((state) => state.setDesktopPetSettings);
  const petEnabled = useSettingsStore((state) => state.petEnabled);
  const setPetEnabled = useSettingsStore((state) => state.setPetEnabled);

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">桌宠</h3>
        <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          这些选项立即生效；独立桌宠与主界面的 GIF 萌宠分别控制。
        </p>
      </div>

      <ToggleRow
        checked={desktopPet.enabled}
        label="启用独立桌宠窗口"
        description="在桌面上显示透明、可拖动的 Live2D 角色窗口。"
        onChange={(enabled) => setDesktopPetSettings({ enabled })}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          角色
          <select
            value={desktopPet.modelId}
            onChange={(event) => setDesktopPetSettings({ modelId: event.target.value as PetModelId })}
            className="rounded-lg border border-black/5 bg-white/50 px-3 py-2.5 text-base text-zinc-800 outline-none transition-all focus:border-sky-400/50 focus:ring-2 focus:ring-sky-400/15 sm:py-2 sm:text-sm dark:border-white/5 dark:bg-slate-800/50 dark:text-zinc-100"
          >
            {MODEL_OPTIONS.map((model) => (
              <option key={model.id} value={model.id}>{model.label}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          缩放 <span className="font-normal text-zinc-500">{desktopPet.scale.toFixed(2)}x</span>
          <input
            type="range"
            min="0.6"
            max="1.8"
            step="0.05"
            value={desktopPet.scale}
            onChange={(event) => setDesktopPetSettings({ scale: clampPetScale(Number(event.target.value)) })}
            className="h-10 w-full accent-sky-500"
          />
        </label>
      </div>

      <ToggleRow
        checked={desktopPet.showOnStartup}
        label="启动时显示"
        description="应用启动后自动恢复桌宠；关闭后仍可从托盘手动显示。"
        onChange={(showOnStartup) => setDesktopPetSettings({ showOnStartup })}
      />
      <ToggleRow
        checked={desktopPet.alwaysOnTop}
        label="始终置顶"
        description="让桌宠保持在其它普通窗口上方。"
        onChange={(alwaysOnTop) => setDesktopPetSettings({ alwaysOnTop })}
      />
      <ToggleRow
        checked={desktopPet.clickThrough}
        label="鼠标穿透"
        description="开启后鼠标会穿过桌宠；可从系统托盘恢复交互。"
        onChange={(clickThrough) => setDesktopPetSettings({ clickThrough })}
      />
      <ToggleRow
        checked={desktopPet.reducedMotion}
        label="减少动态效果"
        description="降低待机和状态切换动画，适合希望画面更安静时使用。"
        onChange={(reducedMotion) => setDesktopPetSettings({ reducedMotion })}
      />

      <ToggleRow
        checked={petEnabled}
        label="主界面 GIF 萌宠"
        description="只控制 Galcode 主窗口里的原有 GIF 萌宠，不影响独立桌宠。"
        onChange={setPetEnabled}
      />
    </section>
  );
}
