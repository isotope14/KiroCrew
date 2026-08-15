/**
 * A failed GitHub PAT write must SAY it failed.
 *
 * `onSetPat` rejects when the host rejects the write (`notesApi.setPat` throws on
 * any non-OK response, and `savePat` does not catch). Both token buttons used to
 * `await` it unguarded, which cost two things at once: the rejection escaped
 * before `setBusy(false)`, latching `busy` true so BOTH Save and Clear stayed
 * disabled for the rest of the page's life, and nothing was ever rendered — the
 * user saw a dead button and no reason. Worse, the success notice is written on
 * the line after the `await`, so a failure was indistinguishable from a click
 * that never registered.
 *
 * These tests pin the three things that make the failure legible: the reason is
 * shown, it is shown as an alert rather than a status, and the buttons come back.
 * The pasted token surviving a failure is part of the contract too — it is the
 * only copy the user has in hand.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { SettingsPage } from '../apps/md-notebook/SettingsPage'
import type { SettingsPageProps } from '../apps/md-notebook/SettingsPage'
import { DEFAULT_SYNC_SHORTCUT } from '../apps/md-notebook/constants'

function renderSettings(overrides: Partial<SettingsPageProps> = {}) {
  const props: SettingsPageProps = {
    vaults: [],
    activeVaultId: null,
    hasPat: false,
    hasGhAuth: false,
    autoSync: false,
    autoSyncMins: 15,
    autoCommit: false,
    shortcut: DEFAULT_SYNC_SHORTCUT,
    onClose: () => {},
    onSwitchVault: () => {},
    onConnect: () => {},
    onForget: async () => {},
    onSetPat: async () => {},
    onSetKnowledge: async () => {},
    onAutoSync: () => {},
    onAutoSyncMins: () => {},
    onAutoCommit: () => {},
    onSetShortcut: () => {},
    onRecordingChange: () => {},
    ...overrides,
  }
  return render(<SettingsPage {...props} />)
}

const tokenField = () => screen.getByLabelText(/access token/i) as HTMLInputElement
const saveButton = () => screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement
const clearButton = () => screen.getByRole('button', { name: /^clear$/i }) as HTMLButtonElement

describe('md-notebook Settings — GitHub PAT save', () => {
  it('reports the reason, re-enables Save and keeps the pasted token', async () => {
    const onSetPat = vi.fn().mockRejectedValue(new Error('keychain is locked'))
    renderSettings({ onSetPat })

    fireEvent.change(tokenField(), { target: { value: 'github_pat_abc' } })
    fireEvent.click(saveButton())

    // The reason reaches the user, as an alert — a silent failure is the bug.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('keychain is locked')

    // `busy` was released, so the user can actually retry.
    await waitFor(() => expect(saveButton().disabled).toBe(false))

    // Retrying must not mean pasting the token again.
    expect(tokenField().value).toBe('github_pat_abc')
    expect(onSetPat).toHaveBeenCalledWith('github_pat_abc')
  })

  it('reports a non-Error rejection rather than rendering nothing', async () => {
    const onSetPat = vi.fn().mockRejectedValue('403')
    renderSettings({ onSetPat })

    fireEvent.change(tokenField(), { target: { value: 'github_pat_abc' } })
    fireEvent.click(saveButton())

    expect((await screen.findByRole('alert')).textContent).toContain('403')
  })

  it('still confirms success as a status, and clears the field', async () => {
    const onSetPat = vi.fn().mockResolvedValue(undefined)
    renderSettings({ onSetPat })

    fireEvent.change(tokenField(), { target: { value: 'github_pat_abc' } })
    fireEvent.click(saveButton())

    expect((await screen.findByRole('status')).textContent).toContain('Token saved')
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => expect(tokenField().value).toBe(''))
  })
})

describe('md-notebook Settings — GitHub PAT clear', () => {
  it('reports the reason and re-enables Clear', async () => {
    const onSetPat = vi.fn().mockRejectedValue(new Error('host unreachable'))
    renderSettings({ hasPat: true, onSetPat })

    fireEvent.click(clearButton())

    expect((await screen.findByRole('alert')).textContent).toContain('host unreachable')
    await waitFor(() => expect(clearButton().disabled).toBe(false))
    expect(onSetPat).toHaveBeenCalledWith('')
  })

  it('confirms success as a status', async () => {
    renderSettings({ hasPat: true, onSetPat: vi.fn().mockResolvedValue(undefined) })

    fireEvent.click(clearButton())

    expect((await screen.findByRole('status')).textContent).toContain('Token cleared')
  })
})
