import { Component, For, Show } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useConnector, type ConnectorController } from "@/connectors/use-connector"
import { CONNECTOR_LIST, type ConnectorDefinition } from "@/connectors/registry"
import { ConnectorCard } from "./connector-card"
import { ConnectorModal } from "./connector-modal"
import "./settings-v2.css"

export const SettingsConnectorsV2: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()

  // One controller per registered connector, created once for this view.
  const controllers = new Map<string, ConnectorController>()
  for (const def of CONNECTOR_LIST) controllers.set(def.id, useConnector(def))

  const get = (def: ConnectorDefinition): ConnectorController => controllers.get(def.id)!

  // A transport is available on desktop (platform bridge) or web (server proxy).
  const available = () => CONNECTOR_LIST.some((def) => get(def).available())

  const openModal = (def: ConnectorDefinition) => {
    const connector = get(def)
    if (!connector.available()) return
    void dialog.show(() => <ConnectorModal def={def} controller={connector} />)
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">
          {language.t("settings.tab.connectors")}
        </h2>
      </div>

      <div class="settings-v2-tab-body">
        <Show
          when={available()}
          fallback={
            <div class="settings-v2-placeholder">
              <p class="settings-v2-placeholder-text">
                {language.t("settings.connectors.unavailable")}
              </p>
            </div>
          }
        >
          <div data-component="connector-list">
            <For each={CONNECTOR_LIST}>
              {(def) => {
                const connector = get(def)
                return (
                  <ConnectorCard
                    def={def}
                    status={connector.status()}
                    onToggle={(enabled) => void connector.toggleEnabled(enabled)}
                    onOpen={() => openModal(def)}
                  />
                )
              }}
            </For>
          </div>
        </Show>
      </div>
    </>
  )
}
