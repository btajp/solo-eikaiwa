import type { ReactNode } from "react";

type Props = {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "lg";
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  ariaLabel?: string;
  title?: string;
};

/** 共有ボタン。loading 中はスピナーを出して自動 disabled */
export function Button({ variant = "secondary", size = "md", loading, disabled, onClick, children, ariaLabel, title }: Props) {
  return (
    <button
      className={`btn btn-${variant}${size === "lg" ? " btn-lg" : ""}`}
      onClick={onClick}
      disabled={disabled || loading}
      aria-label={ariaLabel}
      title={title}
    >
      {loading && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}
