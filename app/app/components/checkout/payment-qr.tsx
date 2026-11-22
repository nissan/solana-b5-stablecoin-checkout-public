"use client";

import { createQR } from "@solana/pay";
import { useEffect, useRef } from "react";

/** The Solana Pay QR code for a payment URL, drawn by @solana/pay. */
export function PaymentQR({ url, size = 320 }: { url: string; size?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.replaceChildren();
    createQR(url, size, "white", "black").append(element);
    return () => element.replaceChildren();
  }, [url, size]);

  return (
    <div
      ref={ref}
      role="img"
      aria-label="Solana Pay QR code"
      data-qr-url={url}
      className="overflow-hidden rounded-xl bg-white"
      style={{ width: size, height: size }}
    />
  );
}
