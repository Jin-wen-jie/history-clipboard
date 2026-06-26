import { useClipboardHistory } from "./useClipboardHistory";
import { HistoryPane } from "./HistoryPane";
import { SettingsPane } from "./SettingsPane";
import { ToastContainer, useToasts } from "./Toast";

export function App() {
  const {
    items,
    settings,
    stats,
    filterType,
    search,
    loadState,
    lastAction,
    imageBytes,
    historyListRef,
    setFilterType,
    setSearch,
    copyItem,
    deleteItem,
    togglePinned,
    updateSettings,
    clearCurrent,
    load,
  } = useClipboardHistory();

  const { toasts, addToast, removeToast } = useToasts();

  return (
    <main className="app-shell">
      <HistoryPane
        items={items}
        filterType={filterType}
        search={search}
        loadState={loadState}
        lastAction={lastAction}
        hasSearchQuery={search.trim().length > 0}
        historyListRef={historyListRef}
        onFilterChange={setFilterType}
        onSearchChange={setSearch}
        onRefresh={() => void load()}
        onCopy={copyItem}
        onTogglePin={togglePinned}
        onDelete={deleteItem}
        onCopyItem={copyItem}
        onAddToast={addToast}
      />
      <SettingsPane
        settings={settings}
        stats={stats}
        imageBytes={imageBytes}
        onToggleCapture={() => void updateSettings({ captureEnabled: !settings?.captureEnabled })}
        onToggleLaunchAtStartup={(event) => void updateSettings({ launchAtStartup: event.target.checked })}
        onClear={() => void clearCurrent()}
        onSaveSettings={(patch) => void updateSettings(patch)}
        addToast={addToast}
      />
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </main>
  );
}
