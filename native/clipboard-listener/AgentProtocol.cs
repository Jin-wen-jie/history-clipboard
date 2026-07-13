using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace HistoryClipboard.ClipboardListener
{
    public sealed class AgentTextSegment
    {
        public AgentTextSegment(int offset, int length)
        {
            if (offset < 0)
            {
                throw new ArgumentOutOfRangeException("offset");
            }
            if (length < 0)
            {
                throw new ArgumentOutOfRangeException("length");
            }

            Offset = offset;
            Length = length;
        }

        public int Offset { get; private set; }
        public int Length { get; private set; }
    }

    public sealed class AgentPngSegment
    {
        public AgentPngSegment(int offset, int length, int width, int height)
        {
            if (offset < 0)
            {
                throw new ArgumentOutOfRangeException("offset");
            }
            if (length < 0)
            {
                throw new ArgumentOutOfRangeException("length");
            }
            if (width <= 0)
            {
                throw new ArgumentOutOfRangeException("width");
            }
            if (height <= 0)
            {
                throw new ArgumentOutOfRangeException("height");
            }

            Offset = offset;
            Length = length;
            Width = width;
            Height = height;
        }

        public int Offset { get; private set; }
        public int Length { get; private set; }
        public int Width { get; private set; }
        public int Height { get; private set; }
    }

    public sealed class AgentFrame
    {
        private static readonly byte[] EmptyPayload = new byte[0];
        private static readonly Encoding StrictUtf8 = new UTF8Encoding(false, true);

        private AgentFrame(string type)
        {
            Type = type;
            PayloadBytes = EmptyPayload;
        }

        public string Type { get; private set; }
        public int Pid { get; private set; }
        public bool HasSequence { get; private set; }
        public uint Sequence { get; private set; }
        public long At { get; private set; }
        public long CapturedAt { get; private set; }
        public AgentTextSegment Text { get; private set; }
        public AgentPngSegment Png { get; private set; }
        public string Reason { get; private set; }
        public uint? FromSequence { get; private set; }
        public uint ToSequence { get; private set; }
        public int Dropped { get; private set; }
        public string Code { get; private set; }
        public int PayloadLength { get { return PayloadBytes.Length; } }
        // Same-assembly protocol writers must treat this owned buffer as read-only.
        internal byte[] PayloadBytes { get; private set; }

        public static AgentFrame Ready(int pid, uint sequence, long at)
        {
            if (pid <= 0)
            {
                throw new ArgumentOutOfRangeException("pid");
            }
            AgentProtocol.ValidateTimestamp(at, "at");

            AgentFrame frame = new AgentFrame("ready");
            frame.Pid = pid;
            frame.HasSequence = true;
            frame.Sequence = sequence;
            frame.At = at;
            return frame;
        }

        public static AgentFrame Heartbeat(uint sequence, long at)
        {
            AgentProtocol.ValidateTimestamp(at, "at");

            AgentFrame frame = new AgentFrame("heartbeat");
            frame.HasSequence = true;
            frame.Sequence = sequence;
            frame.At = at;
            return frame;
        }

        public static AgentFrame Snapshot(uint sequence, byte[] payload)
        {
            return Snapshot(sequence, CurrentUnixMilliseconds(), payload);
        }

        public static AgentFrame Snapshot(uint sequence, long capturedAt, byte[] payload)
        {
            if (payload == null)
            {
                throw new ArgumentNullException("payload");
            }

            return Snapshot(
                sequence,
                capturedAt,
                payload,
                new AgentTextSegment(0, payload.Length),
                null);
        }

        public static AgentFrame Snapshot(
            uint sequence,
            long capturedAt,
            byte[] payload,
            AgentTextSegment text,
            AgentPngSegment png)
        {
            return CreateSnapshot(sequence, capturedAt, payload, text, png, true);
        }

        internal static AgentFrame SnapshotOwned(
            uint sequence,
            long capturedAt,
            byte[] payload,
            AgentTextSegment text,
            AgentPngSegment png)
        {
            return CreateSnapshot(sequence, capturedAt, payload, text, png, false);
        }

        private static AgentFrame CreateSnapshot(
            uint sequence,
            long capturedAt,
            byte[] payload,
            AgentTextSegment text,
            AgentPngSegment png,
            bool copyPayload)
        {
            if (payload == null)
            {
                throw new ArgumentNullException("payload");
            }
            AgentProtocol.ValidateTimestamp(capturedAt, "capturedAt");
            ValidatePayloadLayout(payload.Length, text, png);
            ValidateTextEncoding(payload, text);

            AgentFrame frame = new AgentFrame("snapshot");
            frame.HasSequence = true;
            frame.Sequence = sequence;
            frame.CapturedAt = capturedAt;
            frame.PayloadBytes = copyPayload ? CopyPayload(payload) : payload;
            frame.Text = text;
            frame.Png = png;
            return frame;
        }

        public static AgentFrame Gap(
            string reason,
            uint? fromSequence,
            uint toSequence,
            int dropped,
            long at)
        {
            if (!AgentProtocol.IsGapReason(reason))
            {
                throw new ArgumentException("Invalid gap reason.", "reason");
            }
            if (dropped < 0)
            {
                throw new ArgumentOutOfRangeException("dropped");
            }
            AgentProtocol.ValidateTimestamp(at, "at");

            AgentFrame frame = new AgentFrame("gap");
            frame.Reason = reason;
            frame.FromSequence = fromSequence;
            frame.ToSequence = toSequence;
            frame.Dropped = dropped;
            frame.At = at;
            return frame;
        }

        public static AgentFrame Error(string code, uint? sequence, long at)
        {
            if (!AgentProtocol.IsErrorCode(code))
            {
                throw new ArgumentException("Invalid error code.", "code");
            }
            AgentProtocol.ValidateTimestamp(at, "at");

            AgentFrame frame = new AgentFrame("error");
            frame.Code = code;
            frame.HasSequence = sequence.HasValue;
            frame.Sequence = sequence.GetValueOrDefault();
            frame.At = at;
            return frame;
        }

        internal static long CurrentUnixMilliseconds()
        {
            return (DateTime.UtcNow.Ticks - 621355968000000000L) / TimeSpan.TicksPerMillisecond;
        }

        private static void ValidatePayloadLayout(
            int payloadLength,
            AgentTextSegment text,
            AgentPngSegment png)
        {
            if (text == null && png == null)
            {
                if (payloadLength != 0)
                {
                    throw new ArgumentException("Payload must be fully declared.", "payload");
                }
                return;
            }

            if (text != null && png == null)
            {
                ValidateSingleSegment(text.Offset, text.Length, payloadLength);
                return;
            }

            if (text == null)
            {
                ValidateSingleSegment(png.Offset, png.Length, payloadLength);
                return;
            }

            int textEnd = CheckedSegmentEnd(text.Offset, text.Length);
            int pngEnd = CheckedSegmentEnd(png.Offset, png.Length);
            bool textFirst = text.Offset == 0 && textEnd == png.Offset && pngEnd == payloadLength;
            bool pngFirst = png.Offset == 0 && pngEnd == text.Offset && textEnd == payloadLength;
            if (!textFirst && !pngFirst)
            {
                throw new ArgumentException("Payload segments must be contiguous.", "payload");
            }
        }

        private static void ValidateSingleSegment(int offset, int length, int payloadLength)
        {
            if (offset != 0 || CheckedSegmentEnd(offset, length) != payloadLength)
            {
                throw new ArgumentException("Payload segment must cover the payload.", "payload");
            }
        }

        private static void ValidateTextEncoding(byte[] payload, AgentTextSegment text)
        {
            if (text == null)
            {
                return;
            }

            try
            {
                StrictUtf8.GetCharCount(payload, text.Offset, text.Length);
            }
            catch (DecoderFallbackException)
            {
                throw new ArgumentException("Payload must be valid UTF-8 text.", "payload");
            }
        }

        private static byte[] CopyPayload(byte[] payload)
        {
            if (payload.Length == 0)
            {
                return EmptyPayload;
            }

            byte[] owned = new byte[payload.Length];
            Buffer.BlockCopy(payload, 0, owned, 0, payload.Length);
            return owned;
        }

        private static int CheckedSegmentEnd(int offset, int length)
        {
            try
            {
                return checked(offset + length);
            }
            catch (OverflowException)
            {
                throw new ArgumentException("Payload segment is out of range.", "payload");
            }
        }
    }

    public static class AgentProtocol
    {
        public const int MaxFrameLength = 64 * 1024 * 1024;
        internal const int MaxSnapshotHeaderBytes = 512;
        internal const int MaxSnapshotPayloadLength =
            MaxFrameLength - 4 - MaxSnapshotHeaderBytes;
        internal const long MaxJavaScriptSafeInteger = 9007199254740991L;

        public static void WriteFrame(Stream output, AgentFrame frame)
        {
            if (output == null)
            {
                throw new ArgumentNullException("output");
            }
            if (!output.CanWrite)
            {
                throw new ArgumentException("Stream must be writable.", "output");
            }

            byte[] header = SerializeHeader(frame);
            byte[] payload = frame.PayloadBytes;
            int frameLength = CalculateFrameLength(header.Length, payload.Length);

            using (BinaryWriter writer = new BinaryWriter(output, Encoding.UTF8, true))
            {
                writer.Write((uint)frameLength);
                writer.Write((uint)header.Length);
                writer.Write(header);
                writer.Write(payload);
                writer.Flush();
            }
        }

        internal static int GetHeaderLength(AgentFrame frame)
        {
            return SerializeHeader(frame).Length;
        }

        internal static int GetFrameLength(AgentFrame frame)
        {
            byte[] header = SerializeHeader(frame);
            return CalculateFrameLength(header.Length, frame.PayloadLength);
        }

        internal static void ValidateTimestamp(long value, string parameterName)
        {
            if (value < 0 || value > MaxJavaScriptSafeInteger)
            {
                throw new ArgumentOutOfRangeException(parameterName);
            }
        }

        internal static bool IsGapReason(string value)
        {
            return value == "sequence-advanced" || value == "overflow" || value == "clipboard-busy";
        }

        internal static bool IsErrorCode(string value)
        {
            return value == "too-large"
                || value == "clipboard-busy"
                || value == "listener-failed"
                || value == "internal";
        }

        private static int CalculateFrameLength(int headerLength, int payloadLength)
        {
            int frameLength;
            try
            {
                frameLength = checked(4 + headerLength + payloadLength);
            }
            catch (OverflowException)
            {
                throw new InvalidOperationException("Frame too large.");
            }

            if (frameLength > MaxFrameLength)
            {
                throw new InvalidOperationException("Frame too large.");
            }
            return frameLength;
        }

        private static byte[] SerializeHeader(AgentFrame frame)
        {
            if (frame == null)
            {
                throw new ArgumentNullException("frame");
            }

            Dictionary<string, object> header = new Dictionary<string, object>();
            header.Add("version", 1);
            header.Add("type", frame.Type);

            if (frame.Type == "ready")
            {
                header.Add("pid", frame.Pid);
                header.Add("sequence", frame.Sequence);
                header.Add("at", frame.At);
            }
            else if (frame.Type == "heartbeat")
            {
                header.Add("sequence", frame.Sequence);
                header.Add("at", frame.At);
            }
            else if (frame.Type == "snapshot")
            {
                header.Add("sequence", frame.Sequence);
                header.Add("capturedAt", frame.CapturedAt);
                if (frame.Text != null)
                {
                    Dictionary<string, object> text = new Dictionary<string, object>();
                    text.Add("offset", frame.Text.Offset);
                    text.Add("length", frame.Text.Length);
                    header.Add("text", text);
                }
                if (frame.Png != null)
                {
                    Dictionary<string, object> png = new Dictionary<string, object>();
                    png.Add("offset", frame.Png.Offset);
                    png.Add("length", frame.Png.Length);
                    png.Add("width", frame.Png.Width);
                    png.Add("height", frame.Png.Height);
                    header.Add("png", png);
                }
            }
            else if (frame.Type == "gap")
            {
                header.Add("reason", frame.Reason);
                if (frame.FromSequence.HasValue)
                {
                    header.Add("fromSequence", frame.FromSequence.Value);
                }
                header.Add("toSequence", frame.ToSequence);
                header.Add("dropped", frame.Dropped);
                header.Add("at", frame.At);
            }
            else if (frame.Type == "error")
            {
                header.Add("code", frame.Code);
                if (frame.HasSequence)
                {
                    header.Add("sequence", frame.Sequence);
                }
                header.Add("at", frame.At);
            }
            else
            {
                throw new InvalidOperationException("Invalid frame type.");
            }

            JavaScriptSerializer serializer = new JavaScriptSerializer();
            string json = serializer.Serialize(header);
            return Encoding.UTF8.GetBytes(json);
        }
    }
}
