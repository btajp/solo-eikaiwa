import type { ReactNode } from "react";
import { Button as ShadcnButton } from "@/components/ui/button";

type Props = {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "lg";
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  ariaLabel?: string;
  title?: string;
  className?: string;
};

/** variant/size の旧プロップ名 → shadcn Button のプロップ名へのマッピング */
const VARIANT_MAP = {
  primary: "default",
  secondary: "secondary",
  ghost: "ghost",
  danger: "destructive",
} as const;

const SIZE_MAP = {
  md: "default",
  lg: "lg",
} as const;

/**
 * 共有ボタン。shadcn/ui の Button を薄くラップし、旧来のプロップ API
 * （variant: primary/secondary/ghost/danger, size: md/lg, loading）を維持する。
 * loading 中はスピナーを出して自動 disabled（スピナーは既存の .spinner CSS を再利用）。
 */
export function Button({ variant = "secondary", size = "md", loading, disabled, onClick, children, ariaLabel, title, className }: Props) {
  return (
    <ShadcnButton
      variant={VARIANT_MAP[variant]}
      size={SIZE_MAP[size]}
      onClick={onClick}
      disabled={disabled || loading}
      aria-label={ariaLabel}
      title={title}
      aria-busy={loading || undefined}
      className={className}
    >
      {loading && <span className="spinner" aria-hidden />}
      {children}
    </ShadcnButton>
  );
}
