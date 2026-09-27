"use client";

import { useEffect, useRef } from "react";

/**
 * A checkbox that can also show "some but not all". The DOM-only
 * `indeterminate` state has no attribute, so it is set on the element.
 */
export default function MixedCheckbox({ mixed = false, ...props }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(mixed);
  }, [mixed]);
  return <input ref={ref} type="checkbox" {...props} />;
}
