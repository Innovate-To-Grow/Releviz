"use client";

import { useState } from "react";
import AppButton from "@/components/ui/AppButton";
import FormField from "@/components/ui/FormField";
import Modal from "@/components/ui/Modal";
import { GroupIcon, SendIcon } from "@/components/ui/icons";
import MenuButton from "@/components/schedule/participants/MenuButton";
import { describeSelection, weightError } from "@/lib/participants";

/**
 * Sticky bar under the list while people are selected: the count, Clear, and
 * the bulk actions (invite, groups, and a More menu for weight and counting).
 * The parent renders it only when `count > 0`.
 */
export default function SelectionBar({
  count,
  mode = "page",
  notOnPage = 0,
  busy = false,
  readOnly = false,
  onClear,
  onSendInvitation,
  onGroups,
  onSetWeight,
  onCountIn,
  onLeaveOut,
}) {
  const [weightOpen, setWeightOpen] = useState(false);
  const [weight, setWeight] = useState("1");
  const [error, setError] = useState("");
  const locked = busy || readOnly;

  const openWeight = () => {
    setWeight("1");
    setError("");
    setWeightOpen(true);
  };

  const applyWeight = (submitEvent) => {
    submitEvent.preventDefault();
    const message = weightError(weight);
    setError(message);
    if (message) return;
    setWeightOpen(false);
    onSetWeight?.(Number(weight));
  };

  return (
    <div
      className="participants-selection-bar"
      role="region"
      aria-label="Selected people"
    >
      <p className="participants-selection-bar__count mb-0" role="status">
        {describeSelection({ count, mode, notOnPage })}
      </p>
      <div className="participants-selection-bar__actions">
        <AppButton variant="text" size="sm" onClick={onClear} disabled={busy}>
          Clear
        </AppButton>
        <AppButton
          variant="outlined"
          size="sm"
          icon={<SendIcon />}
          onClick={onSendInvitation}
          disabled={locked}
        >
          Send invitation…
        </AppButton>
        <AppButton
          variant="outlined"
          size="sm"
          icon={<GroupIcon />}
          onClick={onGroups}
          disabled={locked}
        >
          Groups…
        </AppButton>
        <MenuButton
          label="More"
          size="sm"
          disabled={locked}
          items={[
            { key: "weight", label: "Set weight…", onSelect: openWeight },
            { key: "count-in", label: "Count in results", onSelect: onCountIn },
            {
              key: "leave-out",
              label: "Leave out of results",
              onSelect: onLeaveOut,
            },
          ]}
        />
      </div>
      {weightOpen && (
        <Modal
          as="form"
          size="sm"
          title="Set weight"
          description={`Applies to the ${count} selected ${count === 1 ? "person" : "people"}.`}
          onClose={() => setWeightOpen(false)}
          onSubmit={applyWeight}
          noValidate
          footer={
            <>
              <AppButton variant="text" onClick={() => setWeightOpen(false)}>
                Cancel
              </AppButton>
              <AppButton type="submit">Apply</AppButton>
            </>
          }
        >
          <FormField
            label="Weight"
            help="Between 0 and 1. At 0 a person counts only in the unweighted score."
            error={error || null}
          >
            <input
              type="number"
              className="form-control"
              inputMode="decimal"
              min="0"
              max="1"
              step="0.05"
              value={weight}
              data-autofocus
              onChange={(event) => {
                setWeight(event.target.value);
                setError("");
              }}
            />
          </FormField>
        </Modal>
      )}
    </div>
  );
}
