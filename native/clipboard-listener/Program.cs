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
        private const int ShutdownPollIntervalMilliseconds = 100;
        private const int WriterDrainTimeoutMilliseconds = 2000;
        private const int WriterJoinTimeoutMilliseconds = 1000;

        private static readonly object QueueSync = new object();
        private static readonly Encoding StrictUtf8 = new UTF8Encoding(false, true);

        private static ClipboardFrameQueue _queue;
        private static CancellationTokenSource _writerCancellation;
        private static ManualResetEvent _writerDrained;
        private static Thread _writerThread;
        private static Stream _standardOutput;
        private static ClipboardListenerWindow _window;
        private static System.Windows.Forms.Timer _heartbeatTimer;
        private static System.Windows.Forms.Timer _shutdownPollTimer;
        private static bool _accepting;
        private static bool _shutdownRequested;
        private static bool _uiShutdownStarted;
        private static bool _writerFailed;
        private static bool _fatalFailure;
        private static uint _lastSequence;
        private static CaptureSequenceTracker _captureSequenceTracker;

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
                    exitCode = RunProduction();
                }
            }
            catch
            {
                exitCode = 1;
                MarkFatalFailure();
                SetShutdownRequested();
                TryEnqueueFixedError("internal", null, true);
            }
            finally
            {
                StopAcceptingFrames();
                StopUiResources();
                ShutdownWriter();
                if (HasFatalFailure())
                {
                    exitCode = 1;
                }
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

            AgentFrame snapshot = AgentFrame.SnapshotOwned(
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

        private static int RunProduction()
        {
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += OnUiThreadException;

            ClipboardSnapshotReader reader = new ClipboardSnapshotReader();
            try
            {
                _window = new ClipboardListenerWindow(
                    delegate { OnClipboardChanged(reader); },
                    BeginUiShutdown);
            }
            catch
            {
                TryEnqueueFixedError("listener-failed", null, true);
                return 1;
            }

            uint readySequence = ReadCurrentSequence();
            _captureSequenceTracker = new CaptureSequenceTracker(readySequence);
            SetAcceptingFrames(true);
            TryEnqueue(
                AgentFrame.Ready(
                    GetCurrentProcessId(),
                    readySequence,
                    AgentFrame.CurrentUnixMilliseconds()),
                false);

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

            _shutdownPollTimer = new System.Windows.Forms.Timer();
            _shutdownPollTimer.Interval = ShutdownPollIntervalMilliseconds;
            _shutdownPollTimer.Tick += delegate
            {
                if (IsShutdownRequested())
                {
                    BeginUiShutdown();
                }
            };
            _shutdownPollTimer.Start();

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
            return HasFatalFailure() ? 1 : 0;
        }

        private static void OnClipboardChanged(ClipboardSnapshotReader reader)
        {
            if (!IsAcceptingFrames())
            {
                return;
            }

            try
            {
                uint observedSequence = ReadCurrentSequence();
                CaptureSequenceObservation initial = _captureSequenceTracker.Classify(observedSequence);
                if (initial.Kind == CaptureSequenceKind.Duplicate
                    || initial.Kind == CaptureSequenceKind.Stale)
                {
                    return;
                }

                ClipboardSnapshotResult result = reader.TryCapture();
                SetLastSequence(result.Sequence);
                CaptureSequenceObservation captured = _captureSequenceTracker.Classify(result.Sequence);
                if (captured.Kind == CaptureSequenceKind.Duplicate
                    || captured.Kind == CaptureSequenceKind.Stale)
                {
                    return;
                }
                PublishCapture(result, captured);
            }
            catch (Exception exception)
            {
                TryEnqueueFixedError(
                    ClipboardSnapshotReader.GetCaptureErrorCode(exception),
                    ReadCurrentSequence(),
                    false);
            }
        }

        private static void PublishCapture(
            ClipboardSnapshotResult result,
            CaptureSequenceObservation observation)
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

            if (result.ErrorCode != null)
            {
                TryEnqueueFixedError(result.ErrorCode, result.Sequence, false);
                return;
            }

            if (observation.Kind == CaptureSequenceKind.Gap)
            {
                if (!TryEnqueue(
                    AgentFrame.Gap(
                        "sequence-advanced",
                        observation.FromSequence,
                        observation.ToSequence,
                        observation.Dropped,
                        now),
                    false))
                {
                    return;
                }
            }

            AgentFrame snapshot;
            string buildError;
            if (TryBuildSnapshotFrame(result, out snapshot, out buildError))
            {
                if (TryEnqueue(snapshot, false))
                {
                    _captureSequenceTracker.Commit(result.Sequence);
                }
            }
            else
            {
                TryEnqueueFixedError(buildError, result.Sequence, false);
            }
        }

        private static bool TryBuildSnapshotFrame(
            ClipboardSnapshotResult result,
            out AgentFrame frame,
            out string errorCode)
        {
            return SnapshotFrameBuilder.TryBuild(result, out frame, out errorCode);
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
            SetShutdownRequested();
            PostShutdownMessage();
        }

        private static void PostShutdownMessage()
        {
            ClipboardListenerWindow window = _window;
            if (window == null || window.Handle == IntPtr.Zero)
            {
                return;
            }
            bool posted = NativeMethods.PostMessage(
                window.Handle,
                (uint)NativeMethods.WM_AGENT_SHUTDOWN,
                UIntPtr.Zero,
                IntPtr.Zero);
            if (!posted)
            {
                SetShutdownRequested();
            }
        }

        private static void BeginUiShutdown()
        {
            if (_uiShutdownStarted)
            {
                return;
            }
            _uiShutdownStarted = true;
            SetShutdownRequested();
            StopAcceptingFrames();
            if (_heartbeatTimer != null)
            {
                _heartbeatTimer.Stop();
            }
            if (_shutdownPollTimer != null)
            {
                _shutdownPollTimer.Stop();
            }
            Application.ExitThread();
        }

        private static void OnUiThreadException(object sender, ThreadExceptionEventArgs arguments)
        {
            MarkFatalFailure();
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
                    if (!_shutdownRequested)
                    {
                        _fatalFailure = true;
                    }
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
            if (_shutdownPollTimer != null)
            {
                _shutdownPollTimer.Stop();
                _shutdownPollTimer.Dispose();
                _shutdownPollTimer = null;
            }
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

            if (!_writerFailed && !_writerDrained.WaitOne(WriterDrainTimeoutMilliseconds))
            {
                // The writer is stuck writing to a full pipe (reader paused or gone).
                // Closing the stream now truncates the in-flight frame, which corrupts
                // the protocol stream for any consumer still reading it. This is the
                // last resort, never a clean shutdown: report it as a failure so the
                // supervisor does not mistake a torn pipe for a successful exit.
                try
                {
                    _standardOutput.Close();
                }
                catch
                {
                }
                MarkForcedWriterTermination();
            }
            _writerCancellation.Cancel();
            bool writerExited = _writerThread.Join(WriterJoinTimeoutMilliseconds);
            if (!writerExited)
            {
                return;
            }

            _standardOutput.Dispose();
            _writerCancellation.Dispose();
            _writerDrained.Dispose();
            _writerThread = null;
        }

        private static void SetShutdownRequested()
        {
            lock (QueueSync)
            {
                _shutdownRequested = true;
            }
        }

        private static bool IsShutdownRequested()
        {
            lock (QueueSync)
            {
                return _shutdownRequested;
            }
        }

        private static void MarkFatalFailure()
        {
            lock (QueueSync)
            {
                _fatalFailure = true;
            }
        }

        private static void MarkForcedWriterTermination()
        {
            // A frame-truncating stdout close is a torn shutdown even when a
            // stop was requested: the writer never finished its current frame.
            MarkFatalFailure();
        }

        private static bool HasFatalFailure()
        {
            lock (QueueSync)
            {
                return _fatalFailure;
            }
        }
    }
}
