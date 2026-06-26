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
    dateFrom,
    dateTo,
    loadState,
    lastAction,
    imageBytes,
    historyListRef,
    setFilterType,
    setSearch,
    setDateFrom,
    setDateTo,
    clearDateFilter,
    copyItem,
    deleteItem,
    deleteItems,
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
        dateFrom={dateFrom}
        dateTo={dateTo}
        loadState={loadState}
        lastAction={lastAction}
        hasSearchQuery={search.trim().length > 0}
        historyListRef={historyListRef}
        onFilterChange={setFilterType}
        onSearchChange={setSearch}
        onDateFromChange={setDateFrom}
        onDateToChange={setDateTo}
        onClearDateFilter={clearDateFilter}
        onRefresh={() => void load()}
        onCopy={copyItem}
        onTogglePin={togglePinned}
        onDelete={deleteItem}
        onDeleteMany={deleteItems}
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
