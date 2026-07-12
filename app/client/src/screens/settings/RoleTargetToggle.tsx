import type { RoleTarget, RoleTargetAvailability } from "../../lib/llm-assignments";

type Props = {
  value: RoleTarget;
  availability: RoleTargetAvailability;
  labels: Record<RoleTarget, string>;
  unavailableNote: string;
  ariaLabel: string;
  disabled: boolean;
  onChange: (target: RoleTarget) => void;
};

/** 1用途の接続割当。設定済み・利用可能な接続だけを選択可能にする。 */
export function RoleTargetToggle(props: Props) {
  const order: RoleTarget[] = ["claude", "openai", "local", "codex"];
  const hasUnavailable = order.some((target) => !props.availability[target].available);
  return (
    <div className="stack">
      <div className="lang-toggle llm-provider-toggle" role="group" aria-label={props.ariaLabel}>
        {order.map((target) => (
          <button
            key={target}
            className={props.value === target ? "is-active" : ""}
            aria-pressed={props.value === target}
            disabled={props.disabled || !props.availability[target].available}
            onClick={() => props.onChange(target)}
          >
            {props.labels[target]}
          </button>
        ))}
      </div>
      {hasUnavailable && <div className="text-sm text-muted">{props.unavailableNote}</div>}
    </div>
  );
}
