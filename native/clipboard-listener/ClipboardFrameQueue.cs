using System;
using System.Collections.Generic;
using System.Threading;

namespace HistoryClipboard.ClipboardListener
{
    public sealed class ClipboardFrameQueue
    {
        private const int MaxControlSlots = 9;

        private readonly object _sync = new object();
        private readonly LinkedList<AgentFrame> _frames = new LinkedList<AgentFrame>();
        private readonly Queue<LinkedListNode<AgentFrame>> _snapshotNodes =
            new Queue<LinkedListNode<AgentFrame>>();
        private readonly Dictionary<string, LinkedListNode<AgentFrame>> _controlNodes =
            new Dictionary<string, LinkedListNode<AgentFrame>>(StringComparer.Ordinal);
        private readonly int _maxFrames;
        private readonly int _maxBytes;
        private long _payloadBytes;

        public ClipboardFrameQueue(int maxFrames, int maxBytes)
        {
            if (maxFrames <= 0)
            {
                throw new ArgumentOutOfRangeException("maxFrames");
            }
            if (maxBytes < 0)
            {
                throw new ArgumentOutOfRangeException("maxBytes");
            }

            _maxFrames = maxFrames;
            _maxBytes = maxBytes;
        }

        internal int QueuedFrameCount
        {
            get
            {
                lock (_sync)
                {
                    return _frames.Count;
                }
            }
        }

        public void Enqueue(AgentFrame frame)
        {
            if (frame == null)
            {
                throw new ArgumentNullException("frame");
            }

            AgentFrame queuedFrame = frame;
            if (frame.Type == "snapshot" && IsTooLarge(frame))
            {
                queuedFrame = AgentFrame.Error(
                    "too-large",
                    frame.Sequence,
                    AgentFrame.CurrentUnixMilliseconds());
            }

            lock (_sync)
            {
                if (queuedFrame.Type == "snapshot")
                {
                    EnqueueSnapshot(queuedFrame);
                }
                else
                {
                    EnqueueControl(queuedFrame);
                }

                // Protocol control frames have zero payload and occupy one of nine fixed keys:
                // ready, heartbeat, three gap reasons, or four error codes.
                if (_controlNodes.Count > MaxControlSlots
                    || (long)_frames.Count > (long)_maxFrames + MaxControlSlots)
                {
                    throw new InvalidOperationException("Queue control bound was exceeded.");
                }
                Monitor.PulseAll(_sync);
            }
        }

        public AgentFrame Take(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CancellationTokenRegistration registration = cancellationToken.Register(delegate
            {
                lock (_sync)
                {
                    Monitor.PulseAll(_sync);
                }
            });

            try
            {
                lock (_sync)
                {
                    while (_frames.Count == 0)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        Monitor.Wait(_sync);
                    }
                    cancellationToken.ThrowIfCancellationRequested();

                    LinkedListNode<AgentFrame> node = _frames.First;
                    AgentFrame frame = node.Value;
                    if (frame.Type == "snapshot")
                    {
                        LinkedListNode<AgentFrame> snapshotNode = _snapshotNodes.Dequeue();
                        if (!object.ReferenceEquals(node, snapshotNode))
                        {
                            throw new InvalidOperationException("Snapshot index is inconsistent.");
                        }
                        _payloadBytes -= frame.PayloadLength;
                    }
                    else
                    {
                        _controlNodes.Remove(GetControlKey(frame));
                    }
                    _frames.Remove(node);
                    return frame;
                }
            }
            finally
            {
                registration.Dispose();
            }
        }

        private void EnqueueSnapshot(AgentFrame frame)
        {
            int dropped = 0;
            uint? firstDroppedSequence = null;
            while (_snapshotNodes.Count >= _maxFrames
                || _payloadBytes > (long)_maxBytes - frame.PayloadLength)
            {
                AgentFrame removed = RemoveOldestSnapshot();
                if (!firstDroppedSequence.HasValue)
                {
                    firstDroppedSequence = removed.Sequence;
                }
                dropped = SaturatingAdd(dropped, 1);
            }

            LinkedListNode<AgentFrame> node = _frames.AddLast(frame);
            _snapshotNodes.Enqueue(node);
            _payloadBytes += frame.PayloadLength;

            if (dropped > 0)
            {
                AgentFrame gap = AgentFrame.Gap(
                    "overflow",
                    firstDroppedSequence,
                    frame.Sequence,
                    dropped,
                    AgentFrame.CurrentUnixMilliseconds());
                EnqueueOrMergeGap(gap, _snapshotNodes.Peek());
            }
        }

        private void EnqueueControl(AgentFrame frame)
        {
            if (frame.Type == "gap")
            {
                EnqueueOrMergeGap(frame, null);
                return;
            }

            string key = GetControlKey(frame);
            LinkedListNode<AgentFrame> existing;
            if (!_controlNodes.TryGetValue(key, out existing))
            {
                _controlNodes.Add(key, _frames.AddLast(frame));
                return;
            }

            // READY keeps its original slot; latest heartbeat/error observations move to the tail.
            // Gaps use the separate merge path so earliest-from and saturated dropped survive.
            existing.Value = frame;
            if (frame.Type == "heartbeat" || frame.Type == "error")
            {
                _frames.Remove(existing);
                _frames.AddLast(existing);
            }
        }

        private void EnqueueOrMergeGap(AgentFrame gap, LinkedListNode<AgentFrame> before)
        {
            string key = GetControlKey(gap);
            LinkedListNode<AgentFrame> existing;
            if (_controlNodes.TryGetValue(key, out existing))
            {
                existing.Value = MergeGap(existing.Value, gap);
                if (before != null)
                {
                    MoveBeforeIfNeeded(existing, before);
                }
                return;
            }

            LinkedListNode<AgentFrame> node = before == null
                ? _frames.AddLast(gap)
                : _frames.AddBefore(before, gap);
            _controlNodes.Add(key, node);
        }

        private void MoveBeforeIfNeeded(
            LinkedListNode<AgentFrame> control,
            LinkedListNode<AgentFrame> before)
        {
            LinkedListNode<AgentFrame> cursor = before;
            while (cursor != null)
            {
                if (object.ReferenceEquals(cursor, control))
                {
                    _frames.Remove(control);
                    _frames.AddBefore(before, control);
                    return;
                }
                cursor = cursor.Next;
            }
        }

        private static AgentFrame MergeGap(AgentFrame existing, AgentFrame incoming)
        {
            uint? fromSequence = existing.FromSequence.HasValue
                ? existing.FromSequence
                : incoming.FromSequence;
            return AgentFrame.Gap(
                existing.Reason,
                fromSequence,
                incoming.ToSequence,
                SaturatingAdd(existing.Dropped, incoming.Dropped),
                incoming.At);
        }

        private static int SaturatingAdd(int left, int right)
        {
            if (left >= int.MaxValue - right)
            {
                return int.MaxValue;
            }
            return left + right;
        }

        private bool IsTooLarge(AgentFrame frame)
        {
            if (frame.PayloadLength > _maxBytes)
            {
                return true;
            }

            try
            {
                AgentProtocol.GetFrameLength(frame);
                return false;
            }
            catch (InvalidOperationException)
            {
                return true;
            }
        }

        private AgentFrame RemoveOldestSnapshot()
        {
            LinkedListNode<AgentFrame> node = _snapshotNodes.Dequeue();
            AgentFrame frame = node.Value;
            _frames.Remove(node);
            _payloadBytes -= frame.PayloadLength;
            return frame;
        }

        private static string GetControlKey(AgentFrame frame)
        {
            if (frame.Type == "ready" || frame.Type == "heartbeat")
            {
                return frame.Type;
            }
            if (frame.Type == "gap")
            {
                return "gap:" + frame.Reason;
            }
            if (frame.Type == "error")
            {
                return "error:" + frame.Code;
            }
            throw new InvalidOperationException("Invalid control frame type.");
        }
    }
}
