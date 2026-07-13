using System;
using System.Collections.Generic;
using System.Threading;

namespace HistoryClipboard.ClipboardListener
{
    public sealed class ClipboardFrameQueue
    {
        private readonly object _sync = new object();
        private readonly LinkedList<AgentFrame> _frames = new LinkedList<AgentFrame>();
        private readonly int _maxFrames;
        private readonly int _maxBytes;
        private int _snapshotCount;
        private long _payloadBytes;
        private int _pendingDropped;
        private uint? _pendingFromSequence;
        private uint _pendingToSequence;

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
                    bool dropped = false;
                    while (_snapshotCount >= _maxFrames
                        || _payloadBytes > (long)_maxBytes - queuedFrame.Payload.Length)
                    {
                        AgentFrame removed = RemoveOldestSnapshot();
                        if (removed == null)
                        {
                            throw new InvalidOperationException("Queue limits cannot be satisfied.");
                        }
                        RecordDrop(removed.Sequence);
                        dropped = true;
                    }
                    if (dropped)
                    {
                        _pendingToSequence = queuedFrame.Sequence;
                    }

                    _snapshotCount++;
                    _payloadBytes += queuedFrame.Payload.Length;
                }

                _frames.AddLast(queuedFrame);
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
                    while (_pendingDropped == 0 && _frames.Count == 0)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        Monitor.Wait(_sync);
                    }
                    cancellationToken.ThrowIfCancellationRequested();

                    if (_pendingDropped > 0)
                    {
                        AgentFrame gap = AgentFrame.Gap(
                            "overflow",
                            _pendingFromSequence,
                            _pendingToSequence,
                            _pendingDropped,
                            AgentFrame.CurrentUnixMilliseconds());
                        _pendingDropped = 0;
                        _pendingFromSequence = null;
                        _pendingToSequence = 0;
                        return gap;
                    }

                    AgentFrame frame = _frames.First.Value;
                    _frames.RemoveFirst();
                    if (frame.Type == "snapshot")
                    {
                        _snapshotCount--;
                        _payloadBytes -= frame.Payload.Length;
                    }
                    return frame;
                }
            }
            finally
            {
                registration.Dispose();
            }
        }

        private bool IsTooLarge(AgentFrame frame)
        {
            if (frame.Payload.Length > _maxBytes)
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
            LinkedListNode<AgentFrame> node = _frames.First;
            while (node != null)
            {
                LinkedListNode<AgentFrame> next = node.Next;
                if (node.Value.Type == "snapshot")
                {
                    AgentFrame frame = node.Value;
                    _frames.Remove(node);
                    _snapshotCount--;
                    _payloadBytes -= frame.Payload.Length;
                    return frame;
                }
                node = next;
            }
            return null;
        }

        private void RecordDrop(uint sequence)
        {
            if (_pendingDropped == 0)
            {
                _pendingFromSequence = sequence;
            }
            if (_pendingDropped < int.MaxValue)
            {
                _pendingDropped++;
            }
        }
    }
}
