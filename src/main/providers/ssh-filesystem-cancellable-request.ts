import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

export function requestSshFilesystemWithSignal<T>(
  mux: SshChannelMultiplexer,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  return (
    signal ? mux.request(method, params, { signal }) : mux.request(method, params)
  ) as Promise<T>
}
