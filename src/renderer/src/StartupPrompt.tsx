import { useState } from "react";

type StartupPromptProps = {
  onChoose: (enabled: boolean) => Promise<void>;
  error: string | null;
};

export function StartupPrompt({ error, onChoose }: StartupPromptProps) {
  const [choosing, setChoosing] = useState(false);

  async function choose(enabled: boolean): Promise<void> {
    if (choosing) {
      return;
    }
    setChoosing(true);
    try {
      await onChoose(enabled);
    } finally {
      setChoosing(false);
    }
  }

  return (
    <div className="startup-prompt-backdrop">
      <section
        className="startup-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="startup-title"
      >
        <h2 id="startup-title">后台记录</h2>
        {error && <p className="startup-prompt-error" role="alert">{error}</p>}
        <div className="startup-prompt-actions">
          <button type="button" disabled={choosing} onClick={() => void choose(false)}>
            暂不启用
          </button>
          <button
            type="button"
            className="primary"
            disabled={choosing}
            autoFocus
            onClick={() => void choose(true)}
          >
            启用后台记录
          </button>
        </div>
      </section>
    </div>
  );
}
