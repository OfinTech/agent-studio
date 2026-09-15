"use client";
import {
  defaultPdfTemplate,
  imageResourcesSchema,
  type ImageResource,
} from "../../../packages/contracts/src/pdf-templates";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  receiptWorkflow,
  addOutcome as attachOutcome,
  type Workflow,
  type WorkflowNode,
  type ToolDefinition,
} from "../../../packages/contracts/src/index";
import { usePathname, useRouter } from "next/navigation";
import { api, type Bootstrap, type Run } from "./platform-types";
export type CanvasState = {
  measurements: Record<string, { width: number; height: number }>;
  viewport?: { x: number; y: number; zoom: number };
};
export function usePlatform() {
  const canvasStates = useRef<Record<string, CanvasState>>({});
  const [data, setData] = useState<Bootstrap>();
  const pathname = usePathname();
  const router = useRouter();
  const view = pathname.split("/")[1];
  const workflowId =
    view === "workflows"
      ? decodeURIComponent(pathname.split("/")[2] ?? "")
      : "";
  const [drafts, setDrafts] = useState<
    Record<string, { draft: Workflow; dirty: boolean }>
  >({});
  const [selections, setSelections] = useState<
    Record<string, string | undefined>
  >({});
  const record = data?.workflows.find((w) => w.id === workflowId);
  const draft = drafts[workflowId]?.draft ?? record?.draft;
  const dirty = drafts[workflowId]?.dirty ?? false;
  const selected = selections[workflowId];
  const [pendingNavigation, setPendingNavigation] = useState<{
    href: string;
    ids: string[];
  }>();
  const [busyAction, setBusyAction] = useState("");
  function setSelected(id: string | undefined) {
    setSelections((previous) => ({ ...previous, [workflowId]: id }));
  }
  const hasUnsavedChanges = Object.values(drafts).some((entry) => entry.dirty);
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsavedChanges]);
  useEffect(() => {
    setPendingNavigation(undefined);
    setModal(null);
    setError("");
    setNotice("");
  }, [pathname]);
  function navigate(href: string) {
    if (href === pathname) return;
    const ids =
      href === "/login"
        ? Object.keys(drafts).filter((id) => drafts[id].dirty)
        : dirty
          ? [workflowId]
          : [];
    if (ids.length) {
      setError("");
      setPendingNavigation({ href, ids });
    } else void action(() => leave(href));
  }
  function onNavigate(href: string) {
    return (event: { preventDefault: () => void }) => {
      event.preventDefault();
      navigate(href);
    };
  }
  async function leave(href: string) {
    if (href === "/login") {
      await api("auth/logout", "POST");
      router.push("/login");
      router.refresh();
    } else router.push(href);
  }
  async function resolveNavigation(discard: boolean) {
    if (!pendingNavigation) return;
    const { href, ids } = pendingNavigation;
    if (discard)
      setDrafts((previous) => {
        const next = { ...previous };
        for (const id of ids) delete next[id];
        return next;
      });
    else for (const id of ids) await save(id);
    await leave(href);
    setPendingNavigation(undefined);
  }
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<
    | "workflow"
    | "workflow-settings"
    | "delete-workflow"
    | "credential"
    | "tool"
    | null
  >(null);
  const [editingTool, setEditingTool] = useState<ToolDefinition>();
  const runTrigger = useRef<HTMLElement | null>(null);
  const [runId, setRunId] = useState<string>();
  const [run, setRun] = useState<Run>();
  const refresh = useCallback(async () => {
    const value = (await api("bootstrap")) as Bootstrap;
    setData(value);
    return value;
  }, []);
  useEffect(() => {
    let cancelled = false;
    api("bootstrap")
      .then((value: Bootstrap) => {
        if (cancelled) return;
        setData(value);
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api("runs/" + runId);
        if (cancelled) return;
        setRun(value);
        if (["queued", "running"].includes(value.status))
          timer = setTimeout(poll, 1500);
        else {
          await refresh();
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId, refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (view === "runs") void refresh().catch((e) => setError(e.message));
  }, [view, refresh]);
  async function action(fn: () => Promise<void>, name = "") {
    setBusyAction(name);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setBusyAction("");
    }
  }
  function update(next: Workflow) {
    setDrafts((previous) => ({
      ...previous,
      [workflowId]: { draft: next, dirty: true },
    }));
  }
  const selectedNode = draft?.nodes.find((n) => n.id === selected);
  function patchNode(patch: Partial<WorkflowNode["data"]>) {
    if (draft && selected)
      update({
        ...draft,
        nodes: draft.nodes.map((n) =>
          n.id === selected ? { ...n, data: { ...n.data, ...patch } } : n,
        ),
      });
  }
  async function save(id = workflowId) {
    const snapshot =
      drafts[id]?.draft ?? data?.workflows.find((w) => w.id === id)?.draft;
    if (!snapshot) return;
    await api("workflows/" + id, "PUT", snapshot);
    // Refresh failures and edits made during the request must not clear the draft.
    await refresh();
    setDrafts((previous) => {
      if (previous[id] && previous[id].draft !== snapshot) return previous;
      return { ...previous, [id]: { draft: snapshot, dirty: false } };
    });
  }
  function addNode(type: WorkflowNode["type"]) {
    if (!draft) return;
    const base: WorkflowNode = receiptWorkflow.nodes.find(
      (n) => n.type === type,
    ) ?? {
      id: type,
      type,
      position: { x: 1000, y: 150 },
      data:
        type === "pdf_template"
          ? {
              label: "PDF template",
              pdfTemplate: structuredClone(defaultPdfTemplate),
            }
          : type === "send_email"
            ? { label: "Send email", subjectTemplate: "", bodyTemplate: "" }
            : { label: "Tool action", arguments: {} },
    };
    const id = draft.nodes.some((n) => n.id === type)
      ? type + "-" + crypto.randomUUID()
      : type;
    update({
      ...draft,
      nodes: [
        ...draft.nodes,
        {
          ...structuredClone(base),
          id,
          position: draft.nodes.some(
            (n) =>
              Math.abs(n.position.x - base.position.x) < 300 &&
              Math.abs(n.position.y - base.position.y) < 240,
          )
            ? {
                x: Math.max(...draft.nodes.map((n) => n.position.x)) + 320,
                y: base.position.y,
              }
            : base.position,
        },
      ],
    });
    setSelected(id);
  }
  function addOutcome(agentId: string) {
    if (!draft) return;
    const id = "outcome-" + crypto.randomUUID();
    update(attachOutcome(draft, agentId, id));
    setSelected(id);
  }
  async function deleteWorkflow() {
    const id = workflowId;
    await api("workflows/" + id, "DELETE");
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    await refresh();
    setModal(null);
    router.push("/workflows");
  }
  function addTemplateImage(id: string, nodeId: string, image: ImageResource) {
    setDrafts((previous) => {
      const current =
        previous[id]?.draft ?? data?.workflows.find((w) => w.id === id)?.draft;
      const node = current?.nodes.find((n) => n.id === nodeId);
      if (!current || !node?.data.pdfTemplate) return previous;
      const images = imageResourcesSchema.safeParse([
        ...node.data.pdfTemplate.images,
        image,
      ]);
      if (!images.success) return previous;
      return {
        ...previous,
        [id]: {
          dirty: true,
          draft: {
            ...current,
            nodes: current.nodes.map((n) =>
              n.id === nodeId
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      pdfTemplate: {
                        ...node.data.pdfTemplate!,
                        images: images.data,
                      },
                    },
                  }
                : n,
            ),
          },
        },
      };
    });
  }
  return {
    addTemplateImage,
    addOutcome,
    deleteWorkflow,
    navigate,
    onNavigate,
    pendingNavigation,
    setPendingNavigation,
    resolveNavigation,
    busyAction,
    canvasStates,
    data,
    view,
    workflowId,
    draft,
    selected,
    setSelected,
    dirty,
    notice,
    setNotice,
    error,
    setError,
    busy,
    modal,
    setModal,
    editingTool,
    setEditingTool,
    runTrigger,
    runId,
    setRunId,
    run,
    setRun,
    refresh,
    action,
    update,
    record,
    selectedNode,
    patchNode,
    save,
    addNode,
  };
}
export type PlatformController = ReturnType<typeof usePlatform>;
