using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace HistoryClipboard.ClipboardListener
{
    internal static class Program
    {
        private const int QueueFrameLimit = 64;
        private const int QueueByteLimit = 64 * 1024 * 1024;
        private const int HeartbeatIntervalMilliseconds = 5000;

        private static readonly object QueueSync = new object();
        private static readonly Encoding StrictUtf8 = new UTF8Encoding(false, true);

        private static ClipboardFrameQueue _queue;
        private static CancellationTokenSource _writerCancellation;
        private static ManualResetEvent _writerDrained;
        private static Thread _writerThread;
        private static Stream _standardOutput;
        private static ClipboardListenerWindow _window;
        private static System.Windows.Forms.Timer _heartbeatTimer;
        private static bool _accepting;
        private static bool _shutdownRequested;
        private static bool _uiShutdownStarted;
        private static bool _writerFailed;
        private static uint _lastSequence;

        [STAThread]
        private static int Main(string[] args)
        {
            int exitCode = 0;
            try
            {
                InitializeWriter();
                if (HasSelfTestArgument(args))
                {
                    RunSelfTest();
                }
                else
                {
                    RunProduction();
                }
            }
            catch
            {
                exitCode = 1;
                TryEnqueueFixedError("internal", null, true);
            }
            finally
            {
                StopAcceptingFrames();
                StopUiResources();
                ShutdownWriter();
            }
            return exitCode;
        }

        private static bool HasSelfTestArgument(string[] args)
        {
            if (args == null)
            {
                return false;
            }
            for (int index = 0; index < args.Length; index++)
            {
                if (args[index] == "--self-test")
                {
                    return true;
                }
            }
            return false;
        }

        private static void InitializeWriter()
        {
            _queue = new ClipboardFrameQueue(QueueFrameLimit, QueueByteLimit);
            _writerCancellation = new CancellationTokenSource();
            _writerDrained = new ManualResetEvent(true);
            _standardOutput = Console.OpenStandardOutput();
            _writerThread = new Thread(WriterLoop);
            _writerThread.IsBackground = true;
            _writerThread.Name = "clipboard-agent-writer";
            _writerThread.Start();
        }

        private static void RunSelfTest()
        {
            SetAcceptingFrames(true);
            long timestamp = AgentFrame.CurrentUnixMilliseconds();
            TryEnqueue(AgentFrame.Ready(GetCurrentProcessId(), 0, timestamp), false);

            byte[] text = StrictUtf8.GetBytes("self-test");
            byte[] png = CreateSelfTestPng();
            byte[] payload = new byte[text.Length + png.Length];
            Buffer.BlockCopy(text, 0, payload, 0, text.Length);
            Buffer.BlockCopy(png, 0, payload, text.Length, png.Length);

            AgentFrame snapshot = AgentFrame.Snapshot(
                0,
                timestamp,
                payload,
                new AgentTextSegment(0, text.Length),
                new AgentPngSegment(text.Length, png.Length, 1, 1));
            TryEnqueue(snapshot, false);
        }

        private static byte[] CreateSelfTestPng()
        {
            using (Bitmap bitmap = new Bitmap(1, 1, PixelFormat.Format32bppArgb))
            {
                bitmap.SetPixel(0, 0, Color.Transparent);
                using (MemoryStream stream = new MemoryStream())
                {
                    bitmap.Save(stream, ImageFormat.Png);
                    return stream.ToArray();
                }
            }
        }

        private static int GetCurrentProcessId()
        {
            using (System.Diagnostics.Process process = System.Diagnostics.Process.GetCurrentProcess())
            {
                return process.Id;
            }
        }

        private static void RunProduction()
        {
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += OnUiThreadException;

            SetAcceptingFrames(true);
            uint readySequence = ReadCurrentSequence();
            TryEnqueue(
                AgentFrame.Ready(
                    GetCurrentProcessId(),
                    readySequence,
                    AgentFrame.CurrentUnixMilliseconds()),
                false);

            ClipboardSnapshotReader reader = new ClipboardSnapshotReader();
            try
            {
                _window = new ClipboardListenerWindow(
                    delegate { OnClipboardChanged(reader); },
                    BeginUiShutdown);
            }
            catch
            {
                TryEnqueueFixedError("listener-failed", readySequence, false);
                return;
            }

            _heartbeatTimer = new System.Windows.Forms.Timer();
            _heartbeatTimer.Interval = HeartbeatIntervalMilliseconds;
            _heartbeatTimer.Tick += delegate
            {
                TryEnqueue(
                    AgentFrame.Heartbeat(
                        ReadCurrentSequence(),
                        AgentFrame.CurrentUnixMilliseconds()),
                    false);
            };
            _heartbeatTimer.Start();

            Thread stdinThread = new Thread(StdinLoop);
            stdinThread.IsBackground = true;
            stdinThread.Name = "clipboard-agent-stdin";
            stdinThread.Start();

            bool shutdownAlreadyRequested;
            lock (QueueSync)
            {
                shutdownAlreadyRequested = _shutdownRequested;
            }
            if (shutdownAlreadyRequested)
            {
                PostShutdownMessage();
            }

            Application.Run();
        }

        private static void OnClipboardChanged(ClipboardSnapshotReader reader)
        {
            if (!IsAcceptingFrames())
            {
                return;
            }

            try
            {
                ClipboardSnapshotResult result = reader.TryCapture();
                SetLastSequence(result.Sequence);
                PublishCapture(result);
            }
            catch
            {
                TryEnqueueFixedError("internal", ReadCurrentSequence(), false);
            }
        }

        private static void PublishCapture(ClipboardSnapshotResult result)
        {
            long now = AgentFrame.CurrentUnixMilliseconds();
            if (result.IsClipboardBusy)
            {
                TryEnqueue(
                    AgentFrame.Gap(
                        "clipboard-busy",
                        result.BeforeSequence,
                        result.Sequence,
                        result.SequenceAdvanced
                            ? CalculateDropped(result.BeforeSequence, result.Sequence)
                            : 0,
                        now),
                    false);
                return;
            }

            if (result.SequenceAdvanced)
            {
                TryEnqueue(
                    AgentFrame.Gap(
                        "sequence-advanced",
                        result.BeforeSequence,
                        result.Sequence,
                        CalculateDropped(result.BeforeSequence, result.Sequence),
                        now),
                    false);
            }

            AgentFrame snapshot;
            string buildError;
            if (TryBuildSnapshotFrame(result, out snapshot, out buildError))
            {
                TryEnqueue(snapshot, false);
            }
            else
            {
                TryEnqueueFixedError(buildError, result.Sequence, false);
            }

            if (result.ErrorCode != null)
            {
                TryEnqueueFixedError(result.ErrorCode, result.Sequence, false);
            }
        }

        private static bool TryBuildSnapshotFrame(
            ClipboardSnapshotResult result,
            out AgentFrame frame,
            out string errorCode)
        {
            frame = null;
            errorCode = null;
            try
            {
                byte[] textBytes = null;
                if (result.HasText)
                {
                    int byteCount = StrictUtf8.GetByteCount(result.Text);
                    if (byteCount > AgentProtocol.MaxFrameLength)
                    {
                        errorCode = "too-large";
                        return false;
                    }
                    textBytes = StrictUtf8.GetBytes(result.Text);
                }

                int textLength = textBytes == null ? 0 : textBytes.Length;
                int pngLength = result.PngBytes == null ? 0 : result.PngBytes.Length;
                int payloadLength = checked(textLength + pngLength);
                if (payloadLength > AgentProtocol.MaxFrameLength)
                {
                    errorCode = "too-large";
                    return false;
                }

                byte[] payload = new byte[payloadLength];
                if (textLength > 0)
                {
                    Buffer.BlockCopy(textBytes, 0, payload, 0, textLength);
                }
                if (pngLength > 0)
                {
                    Buffer.BlockCopy(result.PngBytes, 0, payload, textLength, pngLength);
                }

                AgentTextSegment textSegment = result.HasText
                    ? new AgentTextSegment(0, textLength)
                    : null;
                AgentPngSegment pngSegment = result.PngBytes == null
                    ? null
                    : new AgentPngSegment(
                        textLength,
                        pngLength,
                        result.PngWidth,
                        result.PngHeight);
                frame = AgentFrame.Snapshot(
                    result.Sequence,
                    AgentFrame.CurrentUnixMilliseconds(),
                    payload,
                    textSegment,
                    pngSegment);
                return true;
            }
            catch (OverflowException)
            {
                errorCode = "too-large";
                return false;
            }
            catch (OutOfMemoryException)
            {
                errorCode = "too-large";
                return false;
            }
            catch
            {
                errorCode = "internal";
                return false;
            }
        }

        private static int CalculateDropped(uint fromSequence, uint toSequence)
        {
            uint delta = unchecked(toSequence - fromSequence);
            if (delta > int.MaxValue)
            {
                return int.MaxValue;
            }
            return (int)delta;
        }

        private static void StdinLoop()
        {
            try
            {
                while (true)
                {
                    string command = Console.In.ReadLine();
                    if (command == null || command == "SHUTDOWN")
                    {
                        RequestShutdown();
                        return;
                    }
                    if (command == "PING")
                    {
                        TryEnqueue(
                            AgentFrame.Heartbeat(
                                ReadCurrentSequence(),
                                AgentFrame.CurrentUnixMilliseconds()),
                            false);
                    }
                }
            }
            catch
            {
                RequestShutdown();
            }
        }

        private static void RequestShutdown()
        {
            lock (QueueSync)
            {
                _shutdownRequested = true;
            }
            PostShutdownMessage();
        }

        private static void PostShutdownMessage()
        {
            ClipboardListenerWindow window = _window;
            if (window == null || window.Handle == IntPtr.Zero)
            {
                return;
            }
            NativeMethods.PostMessage(
                window.Handle,
                (uint)NativeMethods.WM_AGENT_SHUTDOWN,
                UIntPtr.Zero,
                IntPtr.Zero);
        }

        private static void BeginUiShutdown()
        {
            if (_uiShutdownStarted)
            {
                return;
            }
            _uiShutdownStarted = true;
            StopAcceptingFrames();
            if (_heartbeatTimer != null)
            {
                _heartbeatTimer.Stop();
            }
            Application.ExitThread();
        }

        private static void OnUiThreadException(object sender, ThreadExceptionEventArgs arguments)
        {
            TryEnqueueFixedError("internal", ReadCurrentSequence(), false);
            BeginUiShutdown();
        }

        private static void WriterLoop()
        {
            try
            {
                while (true)
                {
                    AgentFrame frame = _queue.Take(_writerCancellation.Token);
                    AgentProtocol.WriteFrame(_standardOutput, frame);
                    lock (QueueSync)
                    {
                        if (_queue.QueuedFrameCount == 0)
                        {
                            _writerDrained.Set();
                        }
                    }
                }
            }
            catch (OperationCanceledException)
            {
            }
            catch
            {
                lock (QueueSync)
                {
                    _writerFailed = true;
                    _writerDrained.Set();
                }
                RequestShutdown();
            }
        }

        private static bool TryEnqueue(AgentFrame frame, bool allowWhileStopping)
        {
            if (frame == null)
            {
                return false;
            }

            lock (QueueSync)
            {
                if (_queue == null || (_writerFailed && !allowWhileStopping))
                {
                    return false;
                }
                if (!_accepting && !allowWhileStopping)
                {
                    return false;
                }

                _writerDrained.Reset();
                try
                {
                    _queue.Enqueue(frame);
                    return true;
                }
                catch
                {
                    if (_queue.QueuedFrameCount == 0)
                    {
                        _writerDrained.Set();
                    }
                    return false;
                }
            }
        }

        private static void TryEnqueueFixedError(
            string code,
            uint? sequence,
            bool allowWhileStopping)
        {
            try
            {
                TryEnqueue(
                    AgentFrame.Error(code, sequence, AgentFrame.CurrentUnixMilliseconds()),
                    allowWhileStopping);
            }
            catch
            {
            }
        }

        private static void SetAcceptingFrames(bool accepting)
        {
            lock (QueueSync)
            {
                _accepting = accepting;
            }
        }

        private static void StopAcceptingFrames()
        {
            SetAcceptingFrames(false);
        }

        private static bool IsAcceptingFrames()
        {
            lock (QueueSync)
            {
                return _accepting;
            }
        }

        private static uint ReadCurrentSequence()
        {
            try
            {
                uint sequence = NativeMethods.GetClipboardSequenceNumber();
                SetLastSequence(sequence);
                return sequence;
            }
            catch
            {
                lock (QueueSync)
                {
                    return _lastSequence;
                }
            }
        }

        private static void SetLastSequence(uint sequence)
        {
            lock (QueueSync)
            {
                _lastSequence = sequence;
            }
        }

        private static void StopUiResources()
        {
            if (_heartbeatTimer != null)
            {
                _heartbeatTimer.Stop();
                _heartbeatTimer.Dispose();
                _heartbeatTimer = null;
            }
            if (_window != null)
            {
                _window.Dispose();
                _window = null;
            }
        }

        private static void ShutdownWriter()
        {
            if (_writerThread == null)
            {
                return;
            }

            if (!_writerFailed)
            {
                _writerDrained.WaitOne();
            }
            _writerCancellation.Cancel();
            _writerThread.Join();

            _standardOutput.Dispose();
            _writerCancellation.Dispose();
            _writerDrained.Dispose();
            _writerThread = null;
        }
    }
}
