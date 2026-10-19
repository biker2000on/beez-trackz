"use client";

import { Copy, KeyRound, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { createColumnHelper, useTable } from "@tanstack/react-table";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
  dataGridFeatures,
} from "@/components/ui/data-grid";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShortcutForm } from "@/components/ui/shortcut-form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApiaries } from "@/features/apiaries/hooks";

import {
  useAccessProfile,
  useAccessTokens,
  useAccessUsers,
  useCreateAccessToken,
  useCreateAccessUser,
  useDeactivateAccessUser,
  useDeleteAccessToken,
  useUpdateAccessUser,
  type AccessToken,
  type AccessUser,
  type AccessUserPayload,
  type ApiaryRole,
} from "./api";

type RoleChoice = ApiaryRole | "none";

const EMPTY_TOKENS: AccessToken[] = [];
const EMPTY_USERS: AccessUser[] = [];
const tokenColumnHelper = createColumnHelper<
  typeof dataGridFeatures,
  AccessToken
>();
const userColumnHelper = createColumnHelper<
  typeof dataGridFeatures,
  AccessUser
>();

function TokenGrid({
  tokens,
  loading,
  onRevoke,
}: {
  tokens: AccessToken[];
  loading: boolean;
  onRevoke: (token: AccessToken) => void;
}) {
  const columns = React.useMemo(
    () =>
      tokenColumnHelper.columns([
        tokenColumnHelper.accessor((token) => token.name, {
          id: "name",
          header: "Token",
          meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: token } }) => (
            <span className="inline-flex items-center gap-2">
              <KeyRound className="size-4 text-muted-foreground" />
              {token.name}
            </span>
          ),
        }),
        tokenColumnHelper.accessor((token) => token.lastUsedAt ?? "", {
          id: "lastUsed",
          header: "Last used",
          cell: ({ row: { original: token } }) =>
            token.lastUsedAt
              ? new Date(token.lastUsedAt).toLocaleDateString()
              : "Never used",
        }),
        tokenColumnHelper.accessor((token) => token.createdAt, {
          id: "created",
          header: "Created",
          cell: ({ row: { original: token } }) =>
            new Date(token.createdAt).toLocaleDateString(),
        }),
        tokenColumnHelper.display({
          id: "actions",
          header: "",
          meta: { align: "right" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: token } }) => (
            <DataGridCellAction>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Delete ${token.name}`}
                onClick={() => onRevoke(token)}
              >
                <Trash2 />
              </Button>
            </DataGridCellAction>
          ),
        }),
      ]),
    [onRevoke],
  );
  const table = useTable({
    features: dataGridFeatures,
    columns,
    data: tokens,
    getRowId: (token) => token.id,
  });
  return (
    <div className="rounded-lg border">
      <DataGrid
        table={table}
        aria-label="API tokens"
        listenOnWindow={false}
        searchable={false}
        emptyMessage={loading ? "Loading…" : "No API tokens yet."}
      />
    </div>
  );
}

function userStatus(user: AccessUser): string {
  if (user.isAdmin) return "Administrator";
  if (!user.isActive) return "Disabled";
  if (user.isPending) return "Invite pending";
  return "Active";
}

function UserGrid({
  users,
  onEdit,
  onDisable,
}: {
  users: AccessUser[];
  onEdit: (user: AccessUser) => void;
  onDisable: (user: AccessUser) => void;
}) {
  const columns = React.useMemo(
    () =>
      userColumnHelper.columns([
        userColumnHelper.accessor((user) => user.displayName || user.email || "", {
          id: "name",
          header: "Name",
          meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: user } }) => (
            <span className="inline-flex items-center gap-2">
              <UserRound className="size-4 text-muted-foreground" />
              {user.displayName || user.email}
            </span>
          ),
        }),
        userColumnHelper.accessor((user) => user.email ?? "Local owner", {
          id: "email",
          header: "Email",
          meta: { card: "subtitle" } satisfies DataGridColumnMeta,
        }),
        userColumnHelper.accessor(userStatus, {
          id: "status",
          header: "Status",
          meta: { card: "badge", filter: true, filterAllLabel: "Any status" } satisfies DataGridColumnMeta,
          cell: ({ getValue }) => (
            <Badge variant={getValue() === "Active" ? "secondary" : "outline"}>
              {getValue()}
            </Badge>
          ),
        }),
        userColumnHelper.accessor(
          (user) =>
            user.isAdmin
              ? "Every apiary"
              : user.memberships
                  .map((item) => `${item.apiaryName}: ${item.role}`)
                  .join(", "),
          {
            id: "apiaries",
            header: "Apiaries",
            meta: { cellClassName: "whitespace-normal" } satisfies DataGridColumnMeta,
            cell: ({ getValue }) =>
              getValue() || <span className="text-muted-foreground">None</span>,
          },
        ),
        userColumnHelper.display({
          id: "actions",
          header: "",
          meta: { align: "right" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: user } }) =>
            user.isAdmin ? null : (
              <DataGridCellAction className="inline-flex">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Edit ${user.displayName}`}
                  onClick={() => onEdit(user)}
                >
                  <Pencil />
                </Button>
                {user.isActive ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Disable ${user.displayName}`}
                    onClick={() => onDisable(user)}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </DataGridCellAction>
            ),
        }),
      ]),
    [onEdit, onDisable],
  );
  const table = useTable({
    features: dataGridFeatures,
    columns,
    data: users,
    getRowId: (user) => user.id,
  });
  return (
    <div className="rounded-lg border">
      <DataGrid
        table={table}
        aria-label="Collaborators"
        listenOnWindow={false}
        searchable={users.length > 5}
        emptyMessage="No collaborators yet."
      />
    </div>
  );
}

function UserDialog({
  user,
  open,
  onOpenChange,
}: {
  user?: AccessUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const apiaries = useApiaries();
  const create = useCreateAccessUser();
  const update = useUpdateAccessUser();
  const [displayName, setDisplayName] = React.useState(user?.displayName ?? "");
  const [email, setEmail] = React.useState(user?.email ?? "");
  const [isActive, setIsActive] = React.useState(user?.isActive ?? true);
  const [roles, setRoles] = React.useState<Record<string, RoleChoice>>(
    Object.fromEntries(
      (user?.memberships ?? []).map((membership) => [
        membership.apiaryId,
        membership.role,
      ]),
    ),
  );

  const saving = create.isPending || update.isPending;
  const resetDraft = () => {
    setDisplayName("");
    setEmail("");
    setIsActive(true);
    setRoles({});
  };
  const submit = async (resetAfter = false) => {
    const payload: AccessUserPayload = {
      displayName,
      email,
      isActive,
      memberships: Object.entries(roles)
        .filter((entry): entry is [string, ApiaryRole] => entry[1] !== "none")
        .map(([apiaryId, role]) => ({ apiaryId, role })),
    };
    try {
      if (user) await update.mutateAsync({ id: user.id, payload });
      else await create.mutateAsync(payload);
      toast.success(user ? "Access updated" : "Collaborator added");
      if (resetAfter && !user) resetDraft();
      else onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save access");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{user ? "Edit collaborator" : "Add collaborator"}</DialogTitle>
          <DialogDescription>
            The email must match their OIDC sign-in. Access is granted separately
            for each apiary.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          className="grid gap-4 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onSubmitAndReset={user ? undefined : () => submit(true)}
          onEscape={() => onOpenChange(false)}
        >
          <div className="grid gap-2">
            <Label htmlFor="access-name">Display name</Label>
            <Input
              id="access-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>
          {user ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id="access-active"
                checked={isActive}
                onCheckedChange={(checked) => setIsActive(checked === true)}
              />
              <Label htmlFor="access-active">Account enabled</Label>
            </div>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="access-email">Sign-in email</Label>
            <Input
              id="access-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label>Apiary access</Label>
            <div className="divide-y rounded-lg border">
              {(apiaries.data ?? []).map((apiary) => (
                <div
                  className="flex items-center justify-between gap-3 p-3"
                  key={apiary.id}
                >
                  <span className="min-w-0 truncate text-sm font-medium">
                    {apiary.name}
                  </span>
                  <Select
                    value={roles[apiary.id] ?? "none"}
                    onValueChange={(value: RoleChoice) =>
                      setRoles((current) => ({ ...current, [apiary.id]: value }))
                    }
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No access</SelectItem>
                      <SelectItem value="viewer">Viewer</SelectItem>
                      <SelectItem value="editor">Editor</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save access"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

function TokenManager() {
  const tokens = useAccessTokens();
  const create = useCreateAccessToken();
  const remove = useDeleteAccessToken();
  const [name, setName] = React.useState("");
  const [newToken, setNewToken] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<AccessToken | null>(null);

  async function createToken() {
    try {
      const value = await create.mutateAsync(name);
      setNewToken(value.token);
      setName("");
      toast.success("API token created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create token");
    }
  }

  return (
    <div className="grid gap-3">
      <div className="rounded-lg border bg-muted/30 p-3 text-sm">
        <p className="font-medium">MCP endpoint</p>
        <code className="mt-1 block overflow-x-auto text-xs">
          {typeof window === "undefined"
            ? "/api/v1/mcp"
            : `${window.location.origin}/api/v1/mcp`}
        </code>
        <p className="mt-2 text-xs text-muted-foreground">
          Use an API token as a Bearer token. MCP tools inherit your admin,
          viewer, and editor permissions.
        </p>
      </div>
      <ShortcutForm
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void createToken();
        }}
      >
        <Input
          placeholder="Token name, e.g. Claude Desktop"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          <KeyRound />
          Create
        </Button>
      </ShortcutForm>
      {newToken ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
          <p className="text-sm font-medium">Copy this token now</p>
          <div className="mt-2 flex gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded bg-background p-2 text-xs">
              {newToken}
            </code>
            <Button
              size="icon"
              variant="outline"
              aria-label="Copy API token"
              onClick={() => {
                void navigator.clipboard.writeText(newToken);
                toast.success("Token copied");
              }}
            >
              <Copy />
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            It cannot be shown again after this page is closed.
          </p>
        </div>
      ) : null}
      <TokenGrid
        tokens={tokens.data ?? EMPTY_TOKENS}
        loading={tokens.isPending}
        onRevoke={setRevoking}
      />
      <RevokeTokenDialog
        token={revoking}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        onConfirm={async (token) => {
          try {
            await remove.mutateAsync(token.id);
            toast.success(`Revoked ${token.name}`);
          } catch (error) {
            toast.error(
              error instanceof Error ? error.message : "Could not revoke token",
            );
          }
          setRevoking(null);
        }}
        isPending={remove.isPending}
      />
    </div>
  );
}

/**
 * Revoking a token breaks every integration still using it, and the token
 * itself can never be shown again — so this asks for the token's name to be
 * typed, not just a click.
 */
function RevokeTokenDialog({
  token,
  onOpenChange,
  onConfirm,
  isPending,
}: {
  token: AccessToken | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (token: AccessToken) => void;
  isPending: boolean;
}) {
  const [typed, setTyped] = React.useState("");
  const confirmed = token !== null && typed.trim() === token.name;

  return (
    <AlertDialog
      open={token !== null}
      onOpenChange={(open) => {
        if (!open) setTyped("");
        onOpenChange(open);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {token?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Anything still authenticating with this token — MCP clients,
            scripts — stops working immediately. The token cannot be restored.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="revoke-token-name">
            Type <span className="font-medium">{token?.name}</span> to confirm
          </Label>
          <Input
            id="revoke-token-name"
            autoComplete="off"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep token</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={!confirmed || isPending}
            onClick={(event) => {
              event.preventDefault();
              if (!token || !confirmed) return;
              setTyped("");
              onConfirm(token);
            }}
          >
            {isPending ? "Revoking…" : "Revoke token"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The administrator half of the old "Users, access, and API" accordion
 * (design 2026-09-03 §6.3): who may read and write which apiary. It is the
 * only editor of a collaborator — `/me` shows an account its own memberships
 * read-only.
 */
export function CollaboratorsSection() {
  const users = useAccessUsers();
  const deactivate = useDeactivateAccessUser();
  const [editing, setEditing] = React.useState<AccessUser | undefined>();
  const [dialogOpen, setDialogOpen] = React.useState(false);

  return (
    <div className="grid gap-3" data-config-editor="collaborators">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">Apiary collaborators</h3>
          <p className="text-sm text-muted-foreground">
            Viewers can read records. Editors can also create and change
            records in their assigned apiaries.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditing(undefined);
            setDialogOpen(true);
          }}
        >
          <Plus />
          Add user
        </Button>
      </div>
      <UserGrid
        users={users.data ?? EMPTY_USERS}
        onEdit={(user) => {
          setEditing(user);
          setDialogOpen(true);
        }}
        onDisable={(user) => {
          if (window.confirm(`Disable ${user.displayName}?`)) {
            deactivate.mutate(user.id);
          }
        }}
      />
      {dialogOpen ? (
        <UserDialog
          key={editing?.id ?? "new"}
          user={editing}
          open
          onOpenChange={setDialogOpen}
        />
      ) : null}
    </div>
  );
}

/**
 * The per-user half (design 2026-09-03 §6.1): the apiaries this account can
 * reach, and the personal API and MCP tokens that carry exactly those
 * permissions. Every authenticated user gets it, on `/me`.
 */
export function MyAccessSection() {
  const profile = useAccessProfile();
  const memberships = profile.data?.memberships ?? [];

  return (
    <div className="grid gap-6" data-config-editor="api-tokens">
      <div className="grid gap-2">
        <h3 className="font-semibold">Your apiary access</h3>
        {profile.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : profile.data?.isAdmin ? (
          <p className="text-sm text-muted-foreground">
            You are an administrator: every apiary, read and write.
          </p>
        ) : memberships.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No apiaries are shared with you yet. An administrator adds them
            in Access &amp; integrations.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {memberships.map((membership) => (
              <li
                key={membership.apiaryId}
                className="flex items-center justify-between gap-3 p-3"
              >
                <span className="truncate font-medium">
                  {membership.apiaryName}
                </span>
                <span className="text-muted-foreground">{membership.role}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid gap-2">
        <h3 className="font-semibold">API and MCP tokens</h3>
        <p className="text-sm text-muted-foreground">
          Personal tokens use exactly the same apiary permissions as your
          account.
        </p>
        <TokenManager />
      </div>
    </div>
  );
}
