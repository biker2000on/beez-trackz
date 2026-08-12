"use client";

import { Copy, KeyRound, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  type AccessUser,
  type AccessUserPayload,
  type ApiaryRole,
} from "./api";

type RoleChoice = ApiaryRole | "none";

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
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
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
      <div className="divide-y rounded-lg border">
        {(tokens.data ?? []).map((token) => (
          <div className="flex items-center gap-3 p-3" key={token.id}>
            <KeyRound className="size-4 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{token.name}</p>
              <p className="text-xs text-muted-foreground">
                {token.lastUsedAt
                  ? `Last used ${new Date(token.lastUsedAt).toLocaleDateString()}`
                  : "Never used"}
              </p>
            </div>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Delete ${token.name}`}
              onClick={() => remove.mutate(token.id)}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        {!tokens.isPending && tokens.data?.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">No API tokens yet.</p>
        ) : null}
      </div>
    </div>
  );
}

export function AccessSection() {
  const profile = useAccessProfile();
  const users = useAccessUsers(profile.data?.isAdmin === true);
  const deactivate = useDeactivateAccessUser();
  const [editing, setEditing] = React.useState<AccessUser | undefined>();
  const [dialogOpen, setDialogOpen] = React.useState(false);

  return (
    <div className="grid gap-6">
      {profile.data?.isAdmin ? (
        <div className="grid gap-3">
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
          <div className="divide-y rounded-lg border">
            {(users.data ?? []).map((user) => (
              <div className="flex items-center gap-3 p-3" key={user.id}>
                <UserRound className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {user.displayName || user.email}
                    {user.isAdmin ? " · Administrator" : ""}
                    {user.isPending ? " · Invite pending" : ""}
                    {!user.isActive ? " · Disabled" : ""}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {user.email ?? "Local owner"}{" "}
                    {!user.isAdmin && user.memberships.length
                      ? `· ${user.memberships.map((item) => `${item.apiaryName}: ${item.role}`).join(", ")}`
                      : ""}
                  </p>
                </div>
                {!user.isAdmin ? (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Edit ${user.displayName}`}
                      onClick={() => {
                        setEditing(user);
                        setDialogOpen(true);
                      }}
                    >
                      <Pencil />
                    </Button>
                    {user.isActive ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Disable ${user.displayName}`}
                        onClick={() => {
                          if (window.confirm(`Disable ${user.displayName}?`)) {
                            deactivate.mutate(user.id);
                          }
                        }}
                      >
                        <Trash2 />
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
            ))}
          </div>
          {dialogOpen ? (
            <UserDialog
              key={editing?.id ?? "new"}
              user={editing}
              open
              onOpenChange={setDialogOpen}
            />
          ) : null}
        </div>
      ) : null}
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
