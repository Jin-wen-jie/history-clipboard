import { useClipboardHistory } from "./useClipboardHistory";
import { HistoryPane } from "./HistoryPane";
import { SettingsPane } from "./SettingsPane";
import { StartupPrompt } from "./StartupPrompt";
import { ToastContainer, useToasts } from "./Toast";

export function App() {
  const {
    items,
    settings,
    stats,
    startupState,
    backgroundState,
    startupActionPending,
    startupActionError,
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
    copyPathItem,
    deleteItem,
    deleteItems,
    togglePinned,
    setStartupEnabled,
    updateEditableSettings,
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
    onRefresh={() => void load(true)}
    onCopy={copyItem}
    onCopyPath={copyPathItem}
    onTogglePin={togglePinned}
        onDelete={deleteItem}
        onDeleteMany={deleteItems}
        onCopyItem={copyItem}
        onAddToast={addToast}
      />
      <SettingsPane
        settings={settings}
        stats={stats}
        startupState={startupState}
        backgroundState={backgroundState}
        startupActionPending={startupActionPending}
        imageBytes={imageBytes}
        onToggleCapture={() => void updateEditableSettings({ captureEnabled: !settings?.captureEnabled })}
        onToggleLaunchAtStartup={(enabled) => void setStartupEnabled(enabled)}
        onClear={() => void clearCurrent()}
        onSaveSettings={(patch) => void updateEditableSettings(patch)}
        addToast={addToast}
      />
      {startupState?.pendingDecision === true && startupActionError === null && (
        <StartupPrompt error={startupActionError} onChoose={setStartupEnabled} />
      )}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </main>
  );
}
