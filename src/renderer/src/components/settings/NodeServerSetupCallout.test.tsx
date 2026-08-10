// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { NodeServerSetupCallout } from './NodeServerSetupCallout'

const writeClipboardText = vi.fn()

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { writeClipboardText } }
  })
})

afterEach(cleanup)

describe('NodeServerSetupCallout', () => {
  it('does not expose clipboard failure details', async () => {
    writeClipboardText.mockRejectedValueOnce(new Error('private clipboard detail'))
    render(<NodeServerSetupCallout />)

    await userEvent.click(screen.getByRole('button', { name: 'Copy server command' }))

    expect(toast.error).toHaveBeenCalledWith('Failed to copy server command.')
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain(
      'private clipboard detail'
    )
  })
})
