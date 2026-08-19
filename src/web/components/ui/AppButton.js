"use client";

function AppButton({ type = "button", children, ...props }) {
  return (
    <button type={type} {...props}>
      {children}
    </button>
  );
}

export default AppButton;
