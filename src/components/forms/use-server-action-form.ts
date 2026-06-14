"use client";

import { type FormEvent, useCallback, useRef, useState, useTransition } from "react";

type ServerFormAction<TState> = (
  prevState: TState | null,
  formData: FormData
) => Promise<TState | void>;

type ServerActionSubmit = (eventOrFormData: FormEvent<HTMLFormElement> | FormData) => void;

/**
 * Submit forms from the client with ordinary field names. React action-state
 * forms scope fields as `1_name`, which breaks some deployments.
 */
export function useServerActionForm<TState>(
  action: (prevState: TState, formData: FormData) => Promise<TState | void>,
  initialState: TState
): readonly [TState, ServerActionSubmit, boolean];

export function useServerActionForm<TState>(
  action: ServerFormAction<TState>,
  initialState?: TState | null
): readonly [TState | null, ServerActionSubmit, boolean];

export function useServerActionForm<TState>(
  action: ServerFormAction<TState>,
  initialState: TState | null = null
) {
  const [state, setState] = useState<TState | null>(initialState);
  const stateRef = useRef<TState | null>(initialState);
  const [isPending, startTransition] = useTransition();

  const submit = useCallback(
    (eventOrFormData: FormEvent<HTMLFormElement> | FormData) => {
      const formData =
        eventOrFormData instanceof FormData
          ? eventOrFormData
          : new FormData(eventOrFormData.currentTarget);
      if (!(eventOrFormData instanceof FormData)) {
        eventOrFormData.preventDefault();
      }

      startTransition(async () => {
        const nextState = await action(stateRef.current, formData);
        if (nextState !== undefined) {
          stateRef.current = nextState;
          setState(nextState);
        }
      });
    },
    [action]
  );

  return [state, submit, isPending] as const;
}
