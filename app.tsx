// bb-plugin-specialists — the Specialists page: set up the agents you @mention.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never bundled).
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Specialist } from "./server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type StoredReasoningLevel = (typeof REASONING_LEVELS)[number];

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The specialist list, kept current by the server's change signal. */
function useSpecialists() {
  const rpc = useRpc<typeof rpcContract>();
  const [specialists, setSpecialists] = useState<Specialist[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("specialists_list").then(
      (result) => {
        setSpecialists(result.specialists);
        setError(null);
      },
      (cause: unknown) => setError(errorMessage(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("specialists-changed", refetch);
  return { rpc, specialists, error, setError, refetch };
}

function pickerValue(
  specialist: Specialist,
): ExperimentalProviderModelPickerValue | null {
  if (specialist.providerId === null || specialist.model === null) return null;
  return {
    providerId: specialist.providerId,
    model: specialist.model,
    reasoningLevel: specialist.reasoningLevel ?? "medium",
  };
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint === undefined ? null : (
        <span className="block text-xs text-muted-foreground">{hint}</span>
      )}
    </label>
  );
}

/** `editing` is the specialist being changed, or null for a new one. */
function SpecialistDialog({
  editing,
  onClose,
}: {
  editing: Specialist | null;
  onClose: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [prompt, setPrompt] = useState(editing?.prompt ?? "");
  const [model, setModel] =
    useState<ExperimentalProviderModelPickerValue | null>(
      editing === null ? null : pickerValue(editing),
    );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The picker needs a concrete starting value; ask the server for the
  // default model whenever this specialist has none yet.
  const needsDefault = model === null;
  useEffect(() => {
    if (!needsDefault) return;
    let cancelled = false;
    rpc.call("default_model").then(
      (value) => {
        if (!cancelled && value !== null) setModel(value);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, needsDefault]);

  const cleanName = name.trim().replace(/^@/u, "").toLowerCase();
  const canSave = cleanName !== "" && prompt.trim() !== "" && !pending;
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    setPending(true);
    try {
      const reasoningLevel =
        REASONING_LEVELS.find((level) => level === model?.reasoningLevel) ??
        null;
      await rpc.call("specialists_save", {
        specialist: {
          name: cleanName,
          description: description.trim(),
          prompt: prompt.trim(),
          providerId: model?.providerId ?? null,
          model: model?.model ?? null,
          reasoningLevel: reasoningLevel satisfies StoredReasoningLevel | null,
        },
        replaces: editing?.name ?? null,
      });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={save} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {editing === null ? "New specialist" : `Edit @${editing.name}`}
            </DialogTitle>
            <DialogDescription>
              Mention it in any composer to hand that work off to a new thread.
            </DialogDescription>
          </DialogHeader>
          <Field
            label="Name"
            hint="What you type after @. Lowercase letters, digits, and dashes."
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="reviewer"
              maxLength={32}
              autoFocus={editing === null}
            />
          </Field>
          <Field
            label="Description"
            hint="Shown in the mention menu, and tells other agents when to use it."
          >
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Reviews code changes for bugs and risky design"
              maxLength={300}
            />
          </Field>
          <Field
            label="Prompt"
            hint="Standing instructions. The task it is handed is added after this."
          >
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="You are a meticulous code reviewer. Report correctness bugs first…"
              rows={9}
              className="flex w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </Field>
          <div className="space-y-1.5">
            <span className="block text-sm font-medium">Model</span>
            {model === null ? (
              <p className="text-sm text-muted-foreground">
                Uses the project's default model.
              </p>
            ) : (
              <ProviderModelPicker value={model} onChange={setModel} />
            )}
          </div>
          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {editing === null ? "Create" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SpecialistRow({
  specialist,
  onEdit,
  onRemove,
}: {
  specialist: Specialist;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-start gap-3 py-3 text-sm">
      <Icon name="Bot" className="mt-0.5 size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">@{specialist.name}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {specialist.model ?? "project default model"}
          </span>
        </div>
        {specialist.description === "" ? null : (
          <p className="mt-0.5 text-muted-foreground">
            {specialist.description}
          </p>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground"
        aria-label={`Edit ${specialist.name}`}
        onClick={onEdit}
      >
        <Icon name="Pencil" className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground"
        aria-label={`Remove ${specialist.name}`}
        onClick={onRemove}
      >
        <Icon name="Trash2" className="size-4" />
      </Button>
    </li>
  );
}

function SpecialistsPage() {
  const { rpc, specialists, error, setError } = useSpecialists();
  // undefined: dialog closed. null: creating. Otherwise: editing that one.
  const [dialog, setDialog] = useState<Specialist | null | undefined>(
    undefined,
  );
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Mention a specialist in a message, like{" "}
            <code>ask the @reviewer to look over the unstaged changes</code>,
            and the thread hands that work to a new thread running the
            specialist's prompt and model.
          </p>
          <Button className="shrink-0" onClick={() => setDialog(null)}>
            <Icon name="Plus" className="size-4" />
            New
          </Button>
        </div>
        {error === null ? null : (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-4">
          {specialists === null ? (
            <div
              role="status"
              className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
            >
              Loading specialists…
            </div>
          ) : specialists.length === 0 ? (
            <div
              role="status"
              className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
            >
              No specialists yet. Create one to @mention it.
            </div>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-4">
              {specialists.map((specialist) => (
                <SpecialistRow
                  key={specialist.name}
                  specialist={specialist}
                  onEdit={() => setDialog(specialist)}
                  onRemove={() => {
                    rpc
                      .call("specialists_remove", { name: specialist.name })
                      .catch((cause: unknown) => setError(errorMessage(cause)));
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
      {dialog === undefined ? null : (
        <SpecialistDialog
          key={dialog?.name ?? ""}
          editing={dialog}
          onClose={() => setDialog(undefined)}
        />
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "specialists",
    title: "Specialists",
    icon: "Bot",
    path: "specialists",
    component: SpecialistsPage,
  });
});
