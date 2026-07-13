namespace HistoryClipboard.ClipboardListener
{
    internal enum CaptureSequenceKind
    {
        Duplicate,
        Next,
        Gap,
        Stale
    }

    internal sealed class CaptureSequenceObservation
    {
        internal CaptureSequenceObservation(
            CaptureSequenceKind kind,
            uint fromSequence,
            uint toSequence,
            int dropped)
        {
            Kind = kind;
            FromSequence = fromSequence;
            ToSequence = toSequence;
            Dropped = dropped;
        }

        internal CaptureSequenceKind Kind { get; private set; }
        internal uint FromSequence { get; private set; }
        internal uint ToSequence { get; private set; }
        internal int Dropped { get; private set; }
    }

    internal sealed class CaptureSequenceTracker
    {
        internal CaptureSequenceTracker(uint baseline)
        {
            Watermark = baseline;
        }

        internal uint Watermark { get; private set; }

        internal CaptureSequenceObservation Classify(uint sequence)
        {
            uint delta = unchecked(sequence - Watermark);
            if (delta == 0)
            {
                return new CaptureSequenceObservation(
                    CaptureSequenceKind.Duplicate,
                    Watermark,
                    sequence,
                    0);
            }
            if (delta == 1)
            {
                return new CaptureSequenceObservation(
                    CaptureSequenceKind.Next,
                    Watermark,
                    sequence,
                    0);
            }
            if (delta < 0x80000000)
            {
                return new CaptureSequenceObservation(
                    CaptureSequenceKind.Gap,
                    Watermark,
                    sequence,
                    (int)(delta - 1));
            }
            return new CaptureSequenceObservation(
                CaptureSequenceKind.Stale,
                Watermark,
                sequence,
                0);
        }

        internal void Commit(uint sequence)
        {
            Watermark = sequence;
        }
    }
}
