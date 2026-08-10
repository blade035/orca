import { Copy, Server } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

const NODE_SERVER_COMMAND = 'npx @stablyai/orca@rc'

export function NodeServerSetupCallout(): React.JSX.Element {
  const copyCommand = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(NODE_SERVER_COMMAND)
      toast.success(
        translate(
          'auto.components.settings.NodeServerSetupCallout.copied',
          'Copied server command.'
        )
      )
    } catch {
      toast.error(
        translate(
          'auto.components.settings.NodeServerSetupCallout.copyFailed',
          'Failed to copy server command.'
        )
      )
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border/70 bg-background/60 p-3 shadow-xs">
      <div className="flex items-start gap-2.5">
        <Server className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-medium">
            {translate(
              'auto.components.settings.NodeServerSetupCallout.title',
              'Run Orca on a remote computer'
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.NodeServerSetupCallout.description',
              'With Node.js 24 installed, run this command there—no desktop app, display, or Electron install required.'
            )}
          </p>
        </div>
      </div>
      <div className="group relative rounded-md border border-border/70 bg-editor-surface">
        <code className="block px-3 py-2.5 pr-10 font-mono text-xs text-foreground">
          {NODE_SERVER_COMMAND}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="absolute top-2 right-2"
          aria-label={translate(
            'auto.components.settings.NodeServerSetupCallout.copy',
            'Copy server command'
          )}
          onClick={() => void copyCommand()}
        >
          <Copy className="size-3.5" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.NodeServerSetupCallout.networking',
          'Orca uses Tailscale when available. Otherwise it stays on localhost and prints an SSH tunnel command.'
        )}
      </p>
    </div>
  )
}
