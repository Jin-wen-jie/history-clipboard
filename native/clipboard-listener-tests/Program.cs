using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using HistoryClipboard.ClipboardListener;

internal static class Program
{
    private const long TestTimestamp = 1783828800000L;

    private static int Main()
    {
        try
        {
            PreservesFifoOrder();
            DropsOldestSnapshotAndReportsGap();
            AppliesPayloadByteBudget();
            CountsOnlyPayloadBytes();
            RejectsSnapshotOverQueueBudget();
            RejectsSnapshotOverProtocolBudget();
            AccumulatesMultipleOverflows();
            DoesNotCountControlFramesAsSnapshots();
            CancelsBlockingTake();
            WritesCompatibleBinaryFrame();
            SerializesOnlyWhitelistedHeaderFields();
            ValidatesCrossLanguageNumericFields();
            AcceptsExactFrameLimitAndRejectsOneByteMore();

            Console.Out.WriteLine("clipboard-listener-tests: PASS");
            return 0;
        }
        catch
        {
            Console.Error.WriteLine("clipboard-listener-tests: FAIL");
            Environment.Exit(1);
            return 1;
        }
    }

    private static void PreservesFifoOrder()
    {
        ClipboardFrameQueue queue = new ClipboardFrameQueue(3, 32);
        queue.Enqueue(Snapshot(1, 3));
        queue.Enqueue(Snapshot(2, 4));
        queue.Enqueue(Snapshot(3, 5));

        AssertEqual((uint)1, queue.Take(CancellationToken.None).Sequence);
        AssertEqual((uint)2, queue.Take(CancellationToken.None).Sequence);
        AssertEqual((uint)3, queue.Take(CancellationToken.None).Sequence);
    }

    private static void DropsOldestSnapshotAndReportsGap()
    {
        ClipboardFrameQueue queue = new ClipboardFrameQueue(2, 32);
        queue.Enqueue(Snapshot(1, 12));
        queue.Enqueue(Snapshot(2, 12));
        queue.Enqueue(Snapshot(3, 12));

        AgentFrame gap = queue.Take(CancellationToken.None);
        AgentFrame second = queue.Take(CancellationToken.None);
        AgentFrame third = queue.Take(CancellationToken.None);

        AssertEqual("gap", gap.Type);
        AssertEqual("overflow", gap.Reason);
        AssertEqual(1, gap.Dropped);
        AssertEqual((uint)1, gap.FromSequence.Value);
        AssertEqual((uint)3, gap.ToSequence);
        AssertEqual((uint)2, second.Sequence);
        AssertEqual((uint)3, third.Sequence);
    }

    private static void AppliesPayloadByteBudget()
    {
        ClipboardFrameQueue queue = new ClipboardFrameQueue(4, 10);
        queue.Enqueue(Snapshot(10, 6));
        queue.Enqueue(Snapshot(11, 5));

        AgentFrame gap = queue.Take(CancellationToken.None);
        AgentFrame retained = queue.Take(CancellationToken.None);

        AssertEqual("gap", gap.Type);
        AssertEqual(1, gap.Dropped);
        AssertEqual((uint)11, gap.ToSequence);
        AssertEqual((uint)11, retained.Sequence);
    }

    private static void CountsOnlyPayloadBytes()
    {
        ClipboardFrameQueue queue = new ClipboardFrameQueue(2, 5);
        queue.Enqueue(Snapshot(20, 4));
        queue.Enqueue(Snapshot(21, 1));

        AssertEqual((uint)20, queue.Take(CancellationToken.None).Sequence);
        AssertEqual((uint)21, queue.Take(CancellationToken.None).Sequence);
    }

    private static void RejectsSnapshotOverQueueBudget()
    {
        ClipboardFrameQueue queue = new ClipboardFrameQueue(64, 8);
        queue.Enqueue(Snapshot(30, 9));

        AgentFrame error = queue.Take(CancellationToken.None);
        AssertEqual("error", error.Type);
        AssertEqual("too-large", error.Code);
        AssertEqual((uint)30, error.Sequence);
    }

    private static void RejectsSnapshotOverProtocolBudget()
    {
        ClipboardFrameQueue queue = new ClipboardFrameQueue(64, 64 * 1024 * 1024 + 1);
        queue.Enqueue(AgentFrame.Snapshot(31, TestTimestamp, new byte[64 * 1024 * 1024 + 1]));

        AgentFrame error = queue.Take(CancellationToken.None);
        AssertEqual("error", error.Type);
        AssertEqual("too-large", error.Code);
        AssertEqual((uint)31, error.Sequence);
    }

    private static void AccumulatesMultipleOverflows()
    {
        ClipboardFrameQueue queue = new ClipboardFrameQueue(2, 32);
        queue.Enqueue(Snapshot(40, 1));
        queue.Enqueue(Snapshot(41, 1));
        queue.Enqueue(Snapshot(42, 1));
        queue.Enqueue(Snapshot(43, 1));
        queue.Enqueue(Snapshot(44, 1));

        AgentFrame gap = queue.Take(CancellationToken.None);
        AssertEqual("gap", gap.Type);
        AssertEqual(3, gap.Dropped);
        AssertEqual((uint)40, gap.FromSequence.Value);
        AssertEqual((uint)44, gap.ToSequence);
        AssertEqual((uint)43, queue.Take(CancellationToken.None).Sequence);
        AssertEqual((uint)44, queue.Take(CancellationToken.None).Sequence);
    }

    private static void DoesNotCountControlFramesAsSnapshots()
    {
        ClipboardFrameQueue queue = new ClipboardFrameQueue(1, 8);
        queue.Enqueue(AgentFrame.Heartbeat(50, TestTimestamp));
        queue.Enqueue(Snapshot(51, 1));

        AssertEqual("heartbeat", queue.Take(CancellationToken.None).Type);
        AssertEqual((uint)51, queue.Take(CancellationToken.None).Sequence);
    }

    private static void CancelsBlockingTake()
    {
        ClipboardFrameQueue queue = new ClipboardFrameQueue(1, 1);
        CancellationTokenSource cancellation = new CancellationTokenSource();
        ManualResetEvent started = new ManualResetEvent(false);
        Exception observed = null;
        Thread taker = new Thread(delegate()
        {
            started.Set();
            try
            {
                queue.Take(cancellation.Token);
            }
            catch (Exception error)
            {
                observed = error;
            }
        });
        taker.IsBackground = true;
        taker.Start();

        AssertTrue(started.WaitOne(1000));
        Thread.Sleep(50);
        AssertTrue(taker.IsAlive);
        cancellation.Cancel();
        AssertTrue(taker.Join(2000));
        AssertTrue(observed is OperationCanceledException);

        started.Dispose();
        cancellation.Dispose();
    }

    private static void WritesCompatibleBinaryFrame()
    {
        byte[] payload = new byte[] { 104, 101, 108, 108, 111 };
        AgentFrame frame = AgentFrame.Snapshot(60, TestTimestamp, payload);
        MemoryStream output = new MemoryStream();

        AgentProtocol.WriteFrame(output, frame);
        byte[] encoded = output.ToArray();
        uint frameLength = ReadUInt32LittleEndian(encoded, 0);
        uint headerLength = ReadUInt32LittleEndian(encoded, 4);

        AssertEqual((uint)(encoded.Length - 4), frameLength);
        AssertEqual((int)frameLength, 4 + (int)headerLength + payload.Length);

        string json = Encoding.UTF8.GetString(encoded, 8, (int)headerLength);
        Dictionary<string, object> header = DeserializeHeader(json);
        AssertKeys(header, "version", "type", "sequence", "capturedAt", "text");
        AssertEqual(1, Convert.ToInt32(header["version"]));
        AssertEqual("snapshot", Convert.ToString(header["type"]));
        AssertEqual((uint)60, Convert.ToUInt32(header["sequence"]));
        AssertEqual(TestTimestamp, Convert.ToInt64(header["capturedAt"]));

        Dictionary<string, object> text = AsDictionary(header["text"]);
        AssertKeys(text, "offset", "length");
        AssertEqual(0, Convert.ToInt32(text["offset"]));
        AssertEqual(payload.Length, Convert.ToInt32(text["length"]));

        byte[] actualPayload = new byte[payload.Length];
        Buffer.BlockCopy(encoded, 8 + (int)headerLength, actualPayload, 0, actualPayload.Length);
        AssertBytesEqual(payload, actualPayload);
    }

    private static void SerializesOnlyWhitelistedHeaderFields()
    {
        AssertHeaderKeys(AgentFrame.Ready(123, 70, TestTimestamp),
            "version", "type", "pid", "sequence", "at");
        AssertHeaderKeys(AgentFrame.Heartbeat(71, TestTimestamp),
            "version", "type", "sequence", "at");
        AssertHeaderKeys(AgentFrame.Gap("overflow", 70, 72, 2, TestTimestamp),
            "version", "type", "reason", "fromSequence", "toSequence", "dropped", "at");
        AssertHeaderKeys(AgentFrame.Error("too-large", 72, TestTimestamp),
            "version", "type", "code", "sequence", "at");

        byte[] pngPayload = new byte[] { 1, 2, 3 };
        AgentFrame png = AgentFrame.Snapshot(
            73,
            TestTimestamp,
            pngPayload,
            null,
            new AgentPngSegment(0, pngPayload.Length, 1, 1));
        Dictionary<string, object> pngHeader = DecodeHeader(png);
        AssertKeys(pngHeader, "version", "type", "sequence", "capturedAt", "png");
        AssertKeys(AsDictionary(pngHeader["png"]), "offset", "length", "width", "height");
    }

    private static void ValidatesCrossLanguageNumericFields()
    {
        AssertThrows<ArgumentOutOfRangeException>(delegate()
        {
            AgentFrame.Ready(0, 1, TestTimestamp);
        });
        AssertThrows<ArgumentOutOfRangeException>(delegate()
        {
            AgentFrame.Heartbeat(1, -1);
        });
        AssertThrows<ArgumentOutOfRangeException>(delegate()
        {
            AgentFrame.Heartbeat(1, AgentProtocol.MaxJavaScriptSafeInteger + 1);
        });
        AssertThrows<ArgumentOutOfRangeException>(delegate()
        {
            AgentFrame.Gap("overflow", null, 1, -1, TestTimestamp);
        });
        AssertThrows<ArgumentOutOfRangeException>(delegate()
        {
            new AgentPngSegment(0, 0, 0, 1);
        });
        AssertThrows<ArgumentException>(delegate()
        {
            AgentFrame.Error("not-whitelisted", null, TestTimestamp);
        });
    }

    private static void AcceptsExactFrameLimitAndRejectsOneByteMore()
    {
        AssertEqual(64 * 1024 * 1024, AgentProtocol.MaxFrameLength);

        int probePayloadLength = 10000000;
        AgentFrame probe = AgentFrame.Snapshot(80, TestTimestamp, new byte[probePayloadLength]);
        int headerLength = AgentProtocol.GetHeaderLength(probe);
        int exactPayloadLength = AgentProtocol.MaxFrameLength - 4 - headerLength;
        AssertTrue(exactPayloadLength >= 10000000);

        AgentFrame exact = AgentFrame.Snapshot(80, TestTimestamp, new byte[exactPayloadLength]);
        AssertEqual(headerLength, AgentProtocol.GetHeaderLength(exact));
        CountingStream accepted = new CountingStream();
        AgentProtocol.WriteFrame(accepted, exact);
        AssertEqual((long)AgentProtocol.MaxFrameLength + 4L, accepted.Length);

        exact = null;
        probe = null;
        GC.Collect();
        GC.WaitForPendingFinalizers();

        AgentFrame oversized = AgentFrame.Snapshot(80, TestTimestamp, new byte[exactPayloadLength + 1]);
        CountingStream rejected = new CountingStream();
        AssertThrows<InvalidOperationException>(delegate()
        {
            AgentProtocol.WriteFrame(rejected, oversized);
        });
        AssertEqual(0L, rejected.Length);
    }

    private static AgentFrame Snapshot(uint sequence, int payloadLength)
    {
        return AgentFrame.Snapshot(sequence, TestTimestamp, new byte[payloadLength]);
    }

    private static void AssertHeaderKeys(AgentFrame frame, params string[] keys)
    {
        AssertKeys(DecodeHeader(frame), keys);
    }

    private static Dictionary<string, object> DecodeHeader(AgentFrame frame)
    {
        MemoryStream output = new MemoryStream();
        AgentProtocol.WriteFrame(output, frame);
        byte[] encoded = output.ToArray();
        int headerLength = (int)ReadUInt32LittleEndian(encoded, 4);
        return DeserializeHeader(Encoding.UTF8.GetString(encoded, 8, headerLength));
    }

    private static Dictionary<string, object> DeserializeHeader(string json)
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        return serializer.Deserialize<Dictionary<string, object>>(json);
    }

    private static Dictionary<string, object> AsDictionary(object value)
    {
        Dictionary<string, object> dictionary = value as Dictionary<string, object>;
        AssertTrue(dictionary != null);
        return dictionary;
    }

    private static uint ReadUInt32LittleEndian(byte[] bytes, int offset)
    {
        return (uint)(bytes[offset]
            | (bytes[offset + 1] << 8)
            | (bytes[offset + 2] << 16)
            | (bytes[offset + 3] << 24));
    }

    private static void AssertKeys(Dictionary<string, object> actual, params string[] expected)
    {
        AssertEqual(expected.Length, actual.Count);
        for (int index = 0; index < expected.Length; index++)
        {
            AssertTrue(actual.ContainsKey(expected[index]));
        }
    }

    private static void AssertBytesEqual(byte[] expected, byte[] actual)
    {
        AssertEqual(expected.Length, actual.Length);
        for (int index = 0; index < expected.Length; index++)
        {
            AssertEqual(expected[index], actual[index]);
        }
    }

    private static void AssertThrows<T>(Action action) where T : Exception
    {
        try
        {
            action();
        }
        catch (T)
        {
            return;
        }

        throw new InvalidOperationException("Expected exception was not thrown.");
    }

    private static void AssertTrue(bool condition)
    {
        if (!condition)
        {
            throw new InvalidOperationException("Assertion failed.");
        }
    }

    private static void AssertEqual<T>(T expected, T actual)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException("Assertion failed.");
        }
    }

    private sealed class CountingStream : Stream
    {
        private long _length;

        public override bool CanRead { get { return false; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return true; } }
        public override long Length { get { return _length; } }
        public override long Position
        {
            get { return _length; }
            set { throw new NotSupportedException(); }
        }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            throw new NotSupportedException();
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            throw new NotSupportedException();
        }

        public override void SetLength(long value)
        {
            throw new NotSupportedException();
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            _length = checked(_length + count);
        }
    }
}
