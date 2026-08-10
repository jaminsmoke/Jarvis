import { Component, For, Show, createMemo } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { ConnectorController } from "@/connectors/use-connector"
import type { ConnectorDefinition } from "@/connectors/registry"
import "./settings-v2.css"

export const ConnectorModal: Component<{
  def: ConnectorDefinition
  controller: ConnectorController
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const connector = props.controller
  const prefix = props.def.i18nPrefix

  const status = connector.status
  const device = connector.device
  const polling = connector.polling
  const error = connector.error

  const connectedUser = createMemo(() => (status().connected && !device() ? status().user : undefined))

  const errorMessage = createMemo(() => {
    const code = error()
    if (!code) return null
    if (code === "expired") return language.t(`${prefix}.error.expired`)
    if (code === "denied") return language.t(`${prefix}.error.denied`)
    if (code === "generic") return language.t(`${prefix}.error.generic`)
    return code
  })

  const openVerification = () => {
    const d = device()
    if (!d) return
    platform.openExternal(d.verificationUri)
  }

  return (
    <Dialog size="normal" variant="settings" class="settings-v2-dialog">
      <DialogHeader>
        <DialogTitle>
          <span data-slot="connector-modal-title">
            <Show when={props.def.providerIcon} fallback={<Icon name={props.def.icon as never} />}>
              <ProviderIcon id={props.def.providerIcon!} width="22" height="22" aria-label={language.t(`${prefix}.name`)} />
            </Show>
            {language.t(`${prefix}.name`)}
          </span>
        </DialogTitle>
      </DialogHeader>

      <DialogBody>
        <div data-component="connector-modal">
          {/* Connected state */}
          <Show when={connectedUser()}>
            {(user) => (
              <div data-slot="connector-modal-connected">
                <Show when={user().avatar}>
                  <img src={user().avatar} alt="" width={48} height={48} data-slot="connector-modal-avatar" />
                </Show>
                <div>
                  <div data-slot="connector-modal-user">@{user().login}</div>
                  <div data-slot="connector-modal-connected-text">
                    {language.t(`${prefix}.connected.text`)}
                  </div>
                </div>
              </div>
            )}
          </Show>

          {/* Capabilities / Tools list */}
          <Show when={props.def.tools && props.def.tools.length > 0}>
            <div data-slot="connector-modal-capabilities">
              <h4 data-slot="connector-modal-capabilities-title">Capabilities</h4>
              <div data-slot="connector-modal-capabilities-list">
                <For each={props.def.tools}>
                  {(tool) => (
                    <div data-slot="connector-modal-tool">
                      <span data-slot="connector-modal-tool-name">{tool.name}</span>
                      <span data-slot="connector-modal-tool-desc">{tool.description}</span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* Coming soon for connectors without tools */}
          <Show when={!props.def.disabled && !props.def.tools?.length}>
            <div data-slot="connector-modal-capabilities">
              <h4 data-slot="connector-modal-capabilities-title">Capabilities</h4>
              <p data-slot="connector-modal-coming-soon">
                {language.t("settings.connectors.badge.comingSoon")} &mdash; tools will appear here once available.
              </p>
            </div>
          </Show>

          {/* Device flow in progress */}
          <Show when={device()}>
            {(flow) => (
              <div data-slot="connector-modal-flow">
                <p data-slot="connector-modal-instructions">
                  {language.t(`${prefix}.code.instructions`)}{" "}
                  <a
                    href={flow().verificationUri}
                    onClick={(e) => {
                      e.preventDefault()
                      openVerification()
                    }}
                  >
                    {flow().verificationUri}
                  </a>
                </p>
                <div data-slot="connector-modal-code">{flow().userCode}</div>
                <Show when={polling()}>
                  <div data-slot="connector-modal-waiting">
                    <span data-slot="connector-modal-spinner" />
                    {language.t(`${prefix}.waiting`)}
                  </div>
                </Show>
              </div>
            )}
          </Show>

          {/* Error */}
          <Show when={errorMessage()}>
            {(message) => <div data-slot="connector-modal-error">{message()}</div>}
          </Show>

          {/* Not connected, no flow in progress */}
          <Show when={!status().connected && !device()}>
            <p data-slot="connector-modal-detail">{language.t(`${prefix}.detail`)}</p>
            <ul data-slot="connector-modal-permissions">
              {props.def.permissions.map((permission) => (
                <li>{language.t(permission)}</li>
              ))}
            </ul>
          </Show>
        </div>
      </DialogBody>

      <DialogFooter>
        <Show
          when={device()}
          fallback={
            <Show
              when={status().connected}
              fallback={
                <ButtonV2 variant="contrast" onClick={() => void connector.startConnect()}>
                  {language.t(`${prefix}.connect`)}
                </ButtonV2>
              }
            >
              <div data-slot="connector-modal-flow-actions">
                <ButtonV2 variant="danger" onClick={() => void connector.disconnect()}>
                  {language.t(`${prefix}.disconnect`)}
                </ButtonV2>
                <ButtonV2 variant="neutral" onClick={() => void connector.reconnect()}>
                  {language.t("settings.connectors.reconnect")}
                </ButtonV2>
              </div>
            </Show>
          }
        >
          <div data-slot="connector-modal-flow-actions">
            <ButtonV2 variant="neutral" onClick={connector.cancelConnect}>
              {language.t(`${prefix}.cancel`)}
            </ButtonV2>
            <ButtonV2 variant="contrast" icon="open-file" onClick={openVerification}>
              {language.t(`${prefix}.openBrowser`)}
            </ButtonV2>
          </div>
        </Show>

        <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
          {language.t("common.close")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
