using System;
using System.Windows.Forms;

namespace HistoryClipboard.ClipboardListener
{
    internal sealed class ClipboardListenerWindow : NativeWindow, IDisposable
    {
        private readonly Action _onClipboardChanged;
        private readonly Action _onShutdownRequested;
        private bool _listenerRegistered;
        private bool _disposed;

        internal ClipboardListenerWindow(Action onClipboardChanged, Action onShutdownRequested)
        {
            if (onClipboardChanged == null)
            {
                throw new ArgumentNullException("onClipboardChanged");
            }
            if (onShutdownRequested == null)
            {
                throw new ArgumentNullException("onShutdownRequested");
            }

            _onClipboardChanged = onClipboardChanged;
            _onShutdownRequested = onShutdownRequested;

            CreateParams parameters = new CreateParams();
            parameters.Parent = NativeMethods.HWND_MESSAGE;
            CreateHandle(parameters);

            bool registered;
            try
            {
                registered = NativeMethods.AddClipboardFormatListener(Handle);
            }
            catch
            {
                DestroyHandle();
                throw new InvalidOperationException("Clipboard listener registration failed.");
            }
            if (!registered)
            {
                DestroyHandle();
                throw new InvalidOperationException("Clipboard listener registration failed.");
            }
            _listenerRegistered = true;
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == NativeMethods.WM_CLIPBOARDUPDATE)
            {
                _onClipboardChanged();
            }
            else if (message.Msg == NativeMethods.WM_AGENT_SHUTDOWN)
            {
                _onShutdownRequested();
            }

            base.WndProc(ref message);
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;

            if (_listenerRegistered)
            {
                try
                {
                    NativeMethods.RemoveClipboardFormatListener(Handle);
                }
                finally
                {
                    _listenerRegistered = false;
                    if (Handle != IntPtr.Zero)
                    {
                        DestroyHandle();
                    }
                }
                return;
            }
            if (Handle != IntPtr.Zero)
            {
                DestroyHandle();
            }
        }
    }
}
