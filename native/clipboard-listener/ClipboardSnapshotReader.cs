using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace HistoryClipboard.ClipboardListener
{
    internal sealed class ClipboardSnapshotResult
    {
        private ClipboardSnapshotResult()
        {
        }

        internal bool IsClipboardBusy { get; private set; }
        internal bool SequenceAdvanced { get; private set; }
        internal uint BeforeSequence { get; private set; }
        internal uint Sequence { get; private set; }
        internal bool HasText { get; private set; }
        internal string Text { get; private set; }
        internal byte[] PngBytes { get; private set; }
        internal int PngWidth { get; private set; }
        internal int PngHeight { get; private set; }
        internal long CapturedAt { get; private set; }
        internal string ErrorCode { get; private set; }

        internal static ClipboardSnapshotResult Busy(
            uint beforeSequence,
            uint observedSequence,
            bool sequenceAdvanced)
        {
            ClipboardSnapshotResult result = new ClipboardSnapshotResult();
            result.IsClipboardBusy = true;
            result.BeforeSequence = beforeSequence;
            result.Sequence = observedSequence;
            result.SequenceAdvanced = sequenceAdvanced;
            return result;
        }

        internal static ClipboardSnapshotResult Success(
            uint beforeSequence,
            uint sequence,
            bool sequenceAdvanced,
            bool hasText,
            string text,
            byte[] pngBytes,
            int pngWidth,
            int pngHeight,
            long capturedAt,
            string errorCode)
        {
            ClipboardSnapshotResult result = new ClipboardSnapshotResult();
            result.BeforeSequence = beforeSequence;
            result.Sequence = sequence;
            result.SequenceAdvanced = sequenceAdvanced;
            result.HasText = hasText;
            result.Text = text;
            result.PngBytes = pngBytes;
            result.PngWidth = pngWidth;
            result.PngHeight = pngHeight;
            result.CapturedAt = capturedAt;
            result.ErrorCode = errorCode;
            return result;
        }
    }

    internal enum CapturedImageCandidateKind
    {
        Png,
        DibV5,
        Dib,
        Bitmap
    }

    internal sealed class CapturedImageCandidate : IDisposable
    {
        private Action _afterDispose;

        private CapturedImageCandidate(
            CapturedImageCandidateKind kind,
            byte[] bytes,
            Bitmap bitmap,
            long storedBytes,
            string errorCode)
        {
            Kind = kind;
            Bytes = bytes;
            Bitmap = bitmap;
            StoredBytes = storedBytes;
            ErrorCode = errorCode;
        }

        internal CapturedImageCandidateKind Kind { get; private set; }
        internal byte[] Bytes { get; private set; }
        internal Bitmap Bitmap { get; private set; }
        internal long StoredBytes { get; private set; }
        internal string ErrorCode { get; private set; }
        internal bool IsDisposed { get; private set; }

        internal static CapturedImageCandidate FromBytes(
            CapturedImageCandidateKind kind,
            byte[] bytes)
        {
            if (bytes == null)
            {
                throw new ArgumentNullException("bytes");
            }
            if (kind == CapturedImageCandidateKind.Bitmap)
            {
                throw new ArgumentException("Bitmap candidates require a bitmap.", "kind");
            }
            return new CapturedImageCandidate(kind, bytes, null, bytes.Length, null);
        }

        internal static CapturedImageCandidate FromBitmap(Bitmap bitmap)
        {
            return FromBitmap(bitmap, null);
        }

        internal static CapturedImageCandidate FromBitmap(Bitmap bitmap, Action afterDispose)
        {
            if (bitmap == null)
            {
                throw new ArgumentNullException("bitmap");
            }
            long storedBytes = checked((long)bitmap.Width * bitmap.Height * 4L);
            CapturedImageCandidate candidate = new CapturedImageCandidate(
                CapturedImageCandidateKind.Bitmap,
                null,
                bitmap,
                storedBytes,
                null);
            candidate._afterDispose = afterDispose;
            return candidate;
        }

        internal static CapturedImageCandidate Failure(
            CapturedImageCandidateKind kind,
            string errorCode)
        {
            if (errorCode != "internal" && errorCode != "too-large")
            {
                throw new ArgumentException("Invalid candidate error.", "errorCode");
            }
            return new CapturedImageCandidate(kind, null, null, 0, errorCode);
        }

        public void Dispose()
        {
            if (IsDisposed)
            {
                return;
            }
            IsDisposed = true;
            Bitmap bitmap = Bitmap;
            Action afterDispose = _afterDispose;
            Bitmap = null;
            Bytes = null;
            StoredBytes = 0;
            _afterDispose = null;
            try
            {
                if (bitmap != null)
                {
                    bitmap.Dispose();
                }
            }
            finally
            {
                if (afterDispose != null)
                {
                    afterDispose();
                }
            }
        }
    }

    internal sealed class CapturedImageConversionResult
    {
        private CapturedImageConversionResult()
        {
        }

        internal byte[] PngBytes { get; private set; }
        internal int Width { get; private set; }
        internal int Height { get; private set; }
        internal CapturedImageCandidateKind? SourceKind { get; private set; }
        internal string ErrorCode { get; private set; }

        internal static CapturedImageConversionResult Empty()
        {
            return new CapturedImageConversionResult();
        }

        internal static CapturedImageConversionResult Success(
            CapturedImageCandidateKind sourceKind,
            byte[] pngBytes,
            int width,
            int height)
        {
            CapturedImageConversionResult result = new CapturedImageConversionResult();
            result.SourceKind = sourceKind;
            result.PngBytes = pngBytes;
            result.Width = width;
            result.Height = height;
            return result;
        }

        internal static CapturedImageConversionResult Failure(string errorCode)
        {
            CapturedImageConversionResult result = new CapturedImageConversionResult();
            result.ErrorCode = errorCode;
            return result;
        }
    }

    internal sealed class CaptureMemoryBudget
    {
        internal CaptureMemoryBudget(long limitBytes)
        {
            if (limitBytes < 0)
            {
                throw new ArgumentOutOfRangeException("limitBytes");
            }
            LimitBytes = limitBytes;
        }

        internal long LimitBytes { get; private set; }
        internal long UsedBytes { get; private set; }
        internal long RemainingBytes { get { return LimitBytes - UsedBytes; } }

        internal bool TryReserve(long bytes)
        {
            if (bytes < 0)
            {
                throw new ArgumentOutOfRangeException("bytes");
            }
            if (bytes > LimitBytes - UsedBytes)
            {
                return false;
            }
            UsedBytes += bytes;
            return true;
        }

        internal void Release(long bytes)
        {
            if (bytes < 0 || bytes > UsedBytes)
            {
                throw new ArgumentOutOfRangeException("bytes");
            }
            UsedBytes -= bytes;
        }
    }

    internal struct CapturedBitmapMetadata
    {
        internal CapturedBitmapMetadata(int width, int height, int stride)
            : this()
        {
            Width = width;
            Height = height;
            Stride = stride;
        }

        internal int Width { get; private set; }
        internal int Height { get; private set; }
        internal int Stride { get; private set; }
    }

    internal interface ICapturedBitmapFactory
    {
        bool TryGetMetadata(IntPtr handle, out CapturedBitmapMetadata metadata);
        Bitmap Clone(IntPtr handle, int width, int height);
    }

    internal sealed class NativeCapturedBitmapFactory : ICapturedBitmapFactory
    {
        internal static readonly NativeCapturedBitmapFactory Instance =
            new NativeCapturedBitmapFactory();

        private NativeCapturedBitmapFactory()
        {
        }

        public bool TryGetMetadata(IntPtr handle, out CapturedBitmapMetadata metadata)
        {
            NativeMethods.BitmapObject bitmapObject;
            int expectedBytes = Marshal.SizeOf(typeof(NativeMethods.BitmapObject));
            int bytes = NativeMethods.GetObject(
                handle,
                expectedBytes,
                out bitmapObject);
            if (bytes != expectedBytes)
            {
                metadata = new CapturedBitmapMetadata();
                return false;
            }
            metadata = new CapturedBitmapMetadata(
                bitmapObject.Width,
                bitmapObject.Height,
                bitmapObject.WidthBytes);
            return true;
        }

        public Bitmap Clone(IntPtr handle, int width, int height)
        {
            using (Bitmap clipboardBitmap = Image.FromHbitmap(handle))
            {
                if (clipboardBitmap.Width != width || clipboardBitmap.Height != height)
                {
                    throw new InvalidDataException();
                }

                Bitmap owned = new Bitmap(width, height, PixelFormat.Format32bppArgb);
                try
                {
                    using (Graphics graphics = Graphics.FromImage(owned))
                    {
                        graphics.Clear(Color.Transparent);
                        graphics.DrawImageUnscaled(clipboardBitmap, 0, 0);
                    }
                    Bitmap result = owned;
                    owned = null;
                    return result;
                }
                finally
                {
                    if (owned != null)
                    {
                        owned.Dispose();
                    }
                }
            }
        }
    }

    internal sealed class CaptureLimitExceededException : IOException
    {
        internal CaptureLimitExceededException()
            : base("Capture limit exceeded.")
        {
        }
    }

    internal sealed class BoundedMemoryStream : Stream
    {
        private readonly MemoryStream _inner;
        private readonly long _maxLength;
        private bool _disposed;

        internal BoundedMemoryStream(long maxLength)
        {
            if (maxLength < 0 || maxLength > int.MaxValue)
            {
                throw new ArgumentOutOfRangeException("maxLength");
            }
            _maxLength = maxLength;
            _inner = new MemoryStream((int)maxLength);
        }

        internal bool LimitExceeded { get; private set; }

        public override bool CanRead { get { return !_disposed && _inner.CanRead; } }
        public override bool CanSeek { get { return !_disposed && _inner.CanSeek; } }
        public override bool CanWrite { get { return !_disposed && _inner.CanWrite; } }
        public override long Length { get { EnsureNotDisposed(); return _inner.Length; } }
        public override long Position
        {
            get { EnsureNotDisposed(); return _inner.Position; }
            set
            {
                EnsureNotDisposed();
                EnsureWithinLimit(value);
                _inner.Position = value;
            }
        }

        public override void Flush()
        {
            EnsureNotDisposed();
            _inner.Flush();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            EnsureNotDisposed();
            return _inner.Read(buffer, offset, count);
        }

        public override int ReadByte()
        {
            EnsureNotDisposed();
            return _inner.ReadByte();
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            EnsureNotDisposed();
            long basis;
            if (origin == SeekOrigin.Begin)
            {
                basis = 0;
            }
            else if (origin == SeekOrigin.Current)
            {
                basis = _inner.Position;
            }
            else if (origin == SeekOrigin.End)
            {
                basis = _inner.Length;
            }
            else
            {
                throw new ArgumentOutOfRangeException("origin");
            }

            long target;
            try
            {
                target = checked(basis + offset);
            }
            catch (OverflowException)
            {
                ThrowLimitExceeded();
                throw;
            }
            EnsureWithinLimit(target);
            _inner.Position = target;
            return target;
        }

        public override void SetLength(long value)
        {
            EnsureNotDisposed();
            EnsureWithinLimit(value);
            _inner.SetLength(value);
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            EnsureNotDisposed();
            if (buffer == null)
            {
                throw new ArgumentNullException("buffer");
            }
            if (offset < 0 || count < 0 || offset > buffer.Length - count)
            {
                throw new ArgumentOutOfRangeException();
            }
            EnsureWriteFits(count);
            _inner.Write(buffer, offset, count);
        }

        public override void WriteByte(byte value)
        {
            EnsureNotDisposed();
            EnsureWriteFits(1);
            _inner.WriteByte(value);
        }

        internal byte[] ToArray()
        {
            EnsureNotDisposed();
            return _inner.ToArray();
        }

        protected override void Dispose(bool disposing)
        {
            if (!_disposed)
            {
                _disposed = true;
                if (disposing)
                {
                    _inner.Dispose();
                }
            }
            base.Dispose(disposing);
        }

        private void EnsureWriteFits(int count)
        {
            long end;
            try
            {
                end = checked(_inner.Position + count);
            }
            catch (OverflowException)
            {
                ThrowLimitExceeded();
                throw;
            }
            EnsureWithinLimit(end);
        }

        private void EnsureWithinLimit(long value)
        {
            if (value < 0)
            {
                throw new IOException("Invalid stream position.");
            }
            if (value > _maxLength)
            {
                ThrowLimitExceeded();
            }
        }

        private void ThrowLimitExceeded()
        {
            LimitExceeded = true;
            throw new CaptureLimitExceededException();
        }

        private void EnsureNotDisposed()
        {
            if (_disposed)
            {
                throw new ObjectDisposedException("BoundedMemoryStream");
            }
        }
    }

    internal sealed class ClipboardSnapshotReader
    {
        private const int OpenTimeoutMilliseconds = 1000;
        private const int OpenRetryDelayMilliseconds = 10;
        private const int MaxClipboardBytes = AgentProtocol.MaxFrameLength;
        private const int MaxImageDimension = 32768;
        private const long MaxImagePixels = 16L * 1024L * 1024L;
        private const long PngAncillaryOverheadBytes = 64L * 1024L;
        private const long PngIdatChunkBytes = 64L * 1024L;
        private const long PngFixedStructureBytes = 45L;
        internal const long MaxCapturedImageCandidateBytes = 64L * 1024L * 1024L;
        internal const long MaxCaptureWorkingBytes = 128L * 1024L * 1024L;

        private static readonly Encoding StrictUnicode = new UnicodeEncoding(false, false, true);
        private static readonly byte[] PngSignature =
            new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 };

        private readonly uint _pngFormat;

        internal ClipboardSnapshotReader()
        {
            _pngFormat = NativeMethods.RegisterClipboardFormat("PNG");
        }

        internal ClipboardSnapshotResult TryCapture()
        {
            uint before = NativeMethods.GetClipboardSequenceNumber();
            uint observed = before;
            bool sequenceAdvanced = false;
            if (!OpenWithRetry(before, out observed, out sequenceAdvanced))
            {
                return ClipboardSnapshotResult.Busy(before, observed, sequenceAdvanced);
            }

            bool hasText = false;
            byte[] unicodeBytes = null;
            List<CapturedImageCandidate> imageCandidates = new List<CapturedImageCandidate>();
            uint after = observed;
            long capturedAt = 0;
            string errorCode = null;

            return ExecuteWithCandidateCleanup(
                imageCandidates,
                delegate
                {
                    try
                    {
                        ReadUnicodeText(out hasText, out unicodeBytes, ref errorCode);
                        ReadImageCandidates(imageCandidates);
                        after = NativeMethods.GetClipboardSequenceNumber();
                        capturedAt = AgentFrame.CurrentUnixMilliseconds();
                        if (after != before)
                        {
                            sequenceAdvanced = true;
                        }
                    }
                    catch
                    {
                        MergeError(ref errorCode, "internal");
                        after = NativeMethods.GetClipboardSequenceNumber();
                        capturedAt = AgentFrame.CurrentUnixMilliseconds();
                    }
                    finally
                    {
                        NativeMethods.CloseClipboard();
                    }

                    string text = null;
                    if (hasText && !TryDecodeUnicode(unicodeBytes, out text))
                    {
                        hasText = false;
                        MergeError(ref errorCode, "internal");
                    }

                    CapturedImageConversionResult image =
                        ConvertFirstValidCandidate(imageCandidates, MaxCaptureWorkingBytes);
                    if (image.ErrorCode != null)
                    {
                        MergeError(ref errorCode, image.ErrorCode);
                    }

                    return ClipboardSnapshotResult.Success(
                        before,
                        after,
                        sequenceAdvanced,
                        hasText,
                        text,
                        image.PngBytes,
                        image.Width,
                        image.Height,
                        capturedAt,
                        errorCode);
                });
        }

        internal static T ExecuteWithCandidateCleanup<T>(
            IList<CapturedImageCandidate> candidates,
            Func<T> action)
        {
            if (candidates == null)
            {
                throw new ArgumentNullException("candidates");
            }
            if (action == null)
            {
                throw new ArgumentNullException("action");
            }

            try
            {
                return action();
            }
            finally
            {
                DisposeCandidatesBestEffort(candidates);
            }
        }

        private static bool OpenWithRetry(
            uint before,
            out uint observed,
            out bool sequenceAdvanced)
        {
            observed = before;
            sequenceAdvanced = false;
            Stopwatch stopwatch = Stopwatch.StartNew();

            while (true)
            {
                if (NativeMethods.OpenClipboard(IntPtr.Zero))
                {
                    return true;
                }

                uint current = NativeMethods.GetClipboardSequenceNumber();
                if (current != observed)
                {
                    observed = current;
                }
                if (current != before)
                {
                    sequenceAdvanced = true;
                }

                long remaining = OpenTimeoutMilliseconds - stopwatch.ElapsedMilliseconds;
                if (remaining <= 0)
                {
                    return false;
                }

                Thread.Sleep((int)Math.Min(OpenRetryDelayMilliseconds, remaining));
            }
        }

        private static void ReadUnicodeText(
            out bool hasText,
            out byte[] unicodeBytes,
            ref string errorCode)
        {
            hasText = false;
            unicodeBytes = null;
            if (!NativeMethods.IsClipboardFormatAvailable(NativeMethods.CF_UNICODETEXT))
            {
                return;
            }

            IntPtr handle = NativeMethods.GetClipboardData(NativeMethods.CF_UNICODETEXT);
            CopyStatus status = CopyGlobalMemory(handle, MaxClipboardBytes, out unicodeBytes);
            if (status == CopyStatus.Success)
            {
                hasText = true;
                return;
            }

            MergeError(ref errorCode, status == CopyStatus.TooLarge ? "too-large" : "internal");
        }

        private void ReadImageCandidates(List<CapturedImageCandidate> candidates)
        {
            CaptureMemoryBudget budget = new CaptureMemoryBudget(MaxCapturedImageCandidateBytes);
            if (_pngFormat != 0)
            {
                TryReadGlobalImageCandidate(
                    _pngFormat,
                    CapturedImageCandidateKind.Png,
                    budget,
                    candidates);
            }
            TryReadGlobalImageCandidate(
                NativeMethods.CF_DIBV5,
                CapturedImageCandidateKind.DibV5,
                budget,
                candidates);
            TryReadGlobalImageCandidate(
                NativeMethods.CF_DIB,
                CapturedImageCandidateKind.Dib,
                budget,
                candidates);
            TryReadBitmapCandidate(budget, candidates);
        }

        private static void TryReadGlobalImageCandidate(
            uint format,
            CapturedImageCandidateKind kind,
            CaptureMemoryBudget budget,
            List<CapturedImageCandidate> candidates)
        {
            if (!NativeMethods.IsClipboardFormatAvailable(format))
            {
                return;
            }

            byte[] bytes;
            CopyStatus status = CopyGlobalMemory(
                NativeMethods.GetClipboardData(format),
                budget.RemainingBytes,
                out bytes);
            if (status == CopyStatus.Success)
            {
                if (budget.TryReserve(bytes.Length))
                {
                    candidates.Add(CapturedImageCandidate.FromBytes(kind, bytes));
                    return;
                }
                status = CopyStatus.TooLarge;
            }

            candidates.Add(CapturedImageCandidate.Failure(
                kind,
                status == CopyStatus.TooLarge ? "too-large" : "internal"));
        }

        private static void TryReadBitmapCandidate(
            CaptureMemoryBudget budget,
            List<CapturedImageCandidate> candidates)
        {
            if (!NativeMethods.IsClipboardFormatAvailable(NativeMethods.CF_BITMAP))
            {
                return;
            }

            IntPtr handle = NativeMethods.GetClipboardData(NativeMethods.CF_BITMAP);
            if (handle == IntPtr.Zero)
            {
                candidates.Add(CapturedImageCandidate.Failure(
                    CapturedImageCandidateKind.Bitmap,
                    "internal"));
                return;
            }

            candidates.Add(CreateBitmapCandidate(
                handle,
                budget,
                MaxCaptureWorkingBytes,
                NativeCapturedBitmapFactory.Instance));
        }

        internal static CapturedImageCandidate CreateBitmapCandidate(
            IntPtr handle,
            CaptureMemoryBudget rawBudget,
            long maxCaptureWorkingBytes,
            ICapturedBitmapFactory factory)
        {
            if (rawBudget == null)
            {
                throw new ArgumentNullException("rawBudget");
            }
            if (factory == null)
            {
                throw new ArgumentNullException("factory");
            }
            if (maxCaptureWorkingBytes < 0)
            {
                throw new ArgumentOutOfRangeException("maxCaptureWorkingBytes");
            }

            long ownedBytes = 0;
            bool reserved = false;
            bool transferred = false;
            Bitmap owned = null;
            try
            {
                CapturedBitmapMetadata metadata;
                if (!factory.TryGetMetadata(handle, out metadata))
                {
                    return CapturedImageCandidate.Failure(
                        CapturedImageCandidateKind.Bitmap,
                        "internal");
                }
                if (metadata.Width <= 0 || metadata.Height == 0 || metadata.Stride == 0)
                {
                    return CapturedImageCandidate.Failure(
                        CapturedImageCandidateKind.Bitmap,
                        "internal");
                }
                if (metadata.Height == int.MinValue || metadata.Stride == int.MinValue)
                {
                    return CapturedImageCandidate.Failure(
                        CapturedImageCandidateKind.Bitmap,
                        "too-large");
                }

                int height = Math.Abs(metadata.Height);
                long stride = Math.Abs((long)metadata.Stride);
                if (!DimensionsAreValid(metadata.Width, height))
                {
                    return CapturedImageCandidate.Failure(
                        CapturedImageCandidateKind.Bitmap,
                        "too-large");
                }

                long sourceBytes = checked(stride * height);
                ownedBytes = checked((long)metadata.Width * height * 4L);
                long cloneBytes = Math.Max(sourceBytes, ownedBytes);
                long capturePeak = checked(
                    rawBudget.UsedBytes + cloneBytes + ownedBytes);
                if (capturePeak > maxCaptureWorkingBytes || !rawBudget.TryReserve(ownedBytes))
                {
                    return CapturedImageCandidate.Failure(
                        CapturedImageCandidateKind.Bitmap,
                        "too-large");
                }
                reserved = true;

                owned = factory.Clone(handle, metadata.Width, height);
                if (owned == null || owned.Width != metadata.Width || owned.Height != height)
                {
                    throw new InvalidDataException();
                }
                CapturedImageCandidate candidate = CapturedImageCandidate.FromBitmap(owned);
                owned = null;
                transferred = true;
                return candidate;
            }
            catch (OverflowException)
            {
                return CapturedImageCandidate.Failure(
                    CapturedImageCandidateKind.Bitmap,
                    "too-large");
            }
            catch (OutOfMemoryException)
            {
                return CapturedImageCandidate.Failure(
                    CapturedImageCandidateKind.Bitmap,
                    "too-large");
            }
            catch
            {
                return CapturedImageCandidate.Failure(
                    CapturedImageCandidateKind.Bitmap,
                    "internal");
            }
            finally
            {
                if (owned != null)
                {
                    owned.Dispose();
                }
                if (reserved && !transferred)
                {
                    rawBudget.Release(ownedBytes);
                }
            }
        }

        private static CopyStatus CopyGlobalMemory(
            IntPtr handle,
            long maxBytes,
            out byte[] bytes)
        {
            bytes = null;
            if (handle == IntPtr.Zero)
            {
                return CopyStatus.Invalid;
            }

            ulong size = NativeMethods.GlobalSize(handle).ToUInt64();
            if (size == 0)
            {
                return CopyStatus.Invalid;
            }
            if (maxBytes < 0
                || size > MaxClipboardBytes
                || size > (ulong)maxBytes
                || size > int.MaxValue)
            {
                return CopyStatus.TooLarge;
            }

            IntPtr pointer = NativeMethods.GlobalLock(handle);
            if (pointer == IntPtr.Zero)
            {
                return CopyStatus.Invalid;
            }

            try
            {
                bytes = new byte[(int)size];
                Marshal.Copy(pointer, bytes, 0, bytes.Length);
                return CopyStatus.Success;
            }
            catch (OutOfMemoryException)
            {
                bytes = null;
                return CopyStatus.TooLarge;
            }
            catch
            {
                bytes = null;
                return CopyStatus.Invalid;
            }
            finally
            {
                NativeMethods.GlobalUnlock(handle);
            }
        }

        private static bool TryDecodeUnicode(byte[] bytes, out string text)
        {
            text = null;
            if (bytes == null || (bytes.Length & 1) != 0)
            {
                return false;
            }

            int length = bytes.Length;
            for (int index = 0; index + 1 < bytes.Length; index += 2)
            {
                if (bytes[index] == 0 && bytes[index + 1] == 0)
                {
                    length = index;
                    break;
                }
            }

            try
            {
                text = StrictUnicode.GetString(bytes, 0, length);
                return true;
            }
            catch (DecoderFallbackException)
            {
                return false;
            }
        }

        internal static CapturedImageConversionResult ConvertFirstValidCandidate(
            IList<CapturedImageCandidate> candidates,
            long maxWorkingBytes)
        {
            if (candidates == null)
            {
                throw new ArgumentNullException("candidates");
            }
            if (maxWorkingBytes < 0)
            {
                throw new ArgumentOutOfRangeException("maxWorkingBytes");
            }

            string errorCode = null;
            bool sawCandidate = false;
            long retainedBytes = 0;
            try
            {
                for (int index = 0; index < candidates.Count; index++)
                {
                    CapturedImageCandidate candidate = candidates[index];
                    if (candidate != null)
                    {
                        retainedBytes = checked(retainedBytes + candidate.StoredBytes);
                    }
                }
            }
            catch (OverflowException)
            {
                retainedBytes = long.MaxValue;
            }

            try
            {
                for (int index = 0; index < candidates.Count; index++)
                {
                    CapturedImageCandidate candidate = candidates[index];
                    if (candidate == null)
                    {
                        MergeError(ref errorCode, "internal");
                        continue;
                    }
                    if (candidate.ErrorCode != null)
                    {
                        MergeError(ref errorCode, candidate.ErrorCode);
                        ReleaseCandidate(candidate, ref retainedBytes);
                        continue;
                    }

                    sawCandidate = true;
                    try
                    {
                        int width;
                        int height;
                        GetCandidateDimensions(candidate, out width, out height);
                        long estimatedBytes = EstimateWorkingBytes(
                            candidate.Kind,
                            candidate.StoredBytes,
                            retainedBytes,
                            width,
                            height);
                        if (estimatedBytes > maxWorkingBytes)
                        {
                            throw new CaptureTooLargeException();
                        }

                        PngData png;
                        if (candidate.Kind == CapturedImageCandidateKind.Png)
                        {
                            png = ValidatePng(candidate.Bytes);
                        }
                        else if (candidate.Kind == CapturedImageCandidateKind.DibV5
                            || candidate.Kind == CapturedImageCandidateKind.Dib)
                        {
                            png = ConvertDib(
                                candidate.Bytes,
                                GetPngOutputLimit(width, height));
                        }
                        else
                        {
                            png = EncodeBitmap(
                                candidate.Bitmap,
                                GetPngOutputLimit(width, height));
                        }
                        return CapturedImageConversionResult.Success(
                            candidate.Kind,
                            png.Bytes,
                            png.Width,
                            png.Height);
                    }
                    catch (CaptureTooLargeException)
                    {
                        MergeError(ref errorCode, "too-large");
                        ReleaseCandidate(candidate, ref retainedBytes);
                    }
                    catch (CaptureLimitExceededException)
                    {
                        MergeError(ref errorCode, "too-large");
                        ReleaseCandidate(candidate, ref retainedBytes);
                    }
                    catch (OutOfMemoryException)
                    {
                        MergeError(ref errorCode, "too-large");
                        ReleaseCandidate(candidate, ref retainedBytes);
                    }
                    catch
                    {
                        MergeError(ref errorCode, "internal");
                        ReleaseCandidate(candidate, ref retainedBytes);
                    }
                }

                if (!sawCandidate && errorCode == null)
                {
                    return CapturedImageConversionResult.Empty();
                }
                return CapturedImageConversionResult.Failure(errorCode ?? "internal");
            }
            finally
            {
                DisposeCandidatesBestEffort(candidates);
            }
        }

        private static void ReleaseCandidate(
            CapturedImageCandidate candidate,
            ref long retainedBytes)
        {
            long storedBytes = candidate.StoredBytes;
            try
            {
                candidate.Dispose();
            }
            catch
            {
            }
            if (retainedBytes != long.MaxValue)
            {
                retainedBytes = storedBytes > retainedBytes
                    ? 0
                    : retainedBytes - storedBytes;
            }
        }

        private static void DisposeCandidatesBestEffort(
            IList<CapturedImageCandidate> candidates)
        {
            for (int index = 0; index < candidates.Count; index++)
            {
                CapturedImageCandidate candidate = candidates[index];
                if (candidate == null)
                {
                    continue;
                }
                try
                {
                    candidate.Dispose();
                }
                catch
                {
                }
            }
        }

        internal static long EstimateWorkingBytes(
            CapturedImageCandidateKind kind,
            long rawBytes,
            long retainedCandidateBytes,
            int width,
            int height)
        {
            if (rawBytes < 0 || retainedCandidateBytes < 0)
            {
                throw new ArgumentOutOfRangeException();
            }
            EnsureDimensions(width, height);

            try
            {
                long pixelBytes = checked((long)width * height * 4L);
                if (kind == CapturedImageCandidateKind.Png)
                {
                    return checked(retainedCandidateBytes + checked(pixelBytes * 2L));
                }
                long estimatedPngBytes = GetPngOutputLimit(width, height);
                if (kind == CapturedImageCandidateKind.DibV5
                    || kind == CapturedImageCandidateKind.Dib)
                {
                    long bitmapWrapper = checked(rawBytes + 14L);
                    return checked(
                        retainedCandidateBytes
                        + bitmapWrapper
                        + checked(pixelBytes * 2L)
                        + checked(estimatedPngBytes * 2L));
                }
                return checked(retainedCandidateBytes + checked(estimatedPngBytes * 2L));
            }
            catch (OverflowException)
            {
                throw new CaptureTooLargeException();
            }
        }

        private static int GetPngOutputLimit(int width, int height)
        {
            EnsureDimensions(width, height);
            try
            {
                long scanlineBytes = checked((checked((long)width * 4L) + 1L) * height);
                long deflateBound = checked(
                    scanlineBytes
                    + (scanlineBytes >> 12)
                    + (scanlineBytes >> 14)
                    + (scanlineBytes >> 25)
                    + 13L);
                long idatChunks = checked(
                    (deflateBound + PngIdatChunkBytes - 1L) / PngIdatChunkBytes);
                long worstCase = checked(
                    deflateBound
                    + checked(idatChunks * 12L)
                    + PngFixedStructureBytes
                    + PngAncillaryOverheadBytes);
                long protocolLimit = Math.Min(
                    MaxClipboardBytes,
                    AgentProtocol.MaxSnapshotPayloadLength);
                return (int)Math.Min(worstCase, protocolLimit);
            }
            catch (OverflowException)
            {
                throw new CaptureTooLargeException();
            }
        }

        private static void GetCandidateDimensions(
            CapturedImageCandidate candidate,
            out int width,
            out int height)
        {
            if (candidate.Kind == CapturedImageCandidateKind.Png)
            {
                GetPngDimensions(candidate.Bytes, out width, out height);
                return;
            }
            if (candidate.Kind == CapturedImageCandidateKind.DibV5
                || candidate.Kind == CapturedImageCandidateKind.Dib)
            {
                GetDibDimensions(candidate.Bytes, out width, out height);
                return;
            }
            if (candidate.Bitmap == null)
            {
                throw new InvalidDataException();
            }
            width = candidate.Bitmap.Width;
            height = candidate.Bitmap.Height;
            EnsureDimensions(width, height);
        }

        private static void GetPngDimensions(byte[] bytes, out int width, out int height)
        {
            if (bytes == null || bytes.Length < 33)
            {
                throw new InvalidDataException();
            }
            for (int index = 0; index < PngSignature.Length; index++)
            {
                if (bytes[index] != PngSignature[index])
                {
                    throw new InvalidDataException();
                }
            }
            if (ReadUInt32BigEndian(bytes, 8) != 13
                || bytes[12] != (byte)'I'
                || bytes[13] != (byte)'H'
                || bytes[14] != (byte)'D'
                || bytes[15] != (byte)'R')
            {
                throw new InvalidDataException();
            }

            uint encodedWidth = ReadUInt32BigEndian(bytes, 16);
            uint encodedHeight = ReadUInt32BigEndian(bytes, 20);
            if (encodedWidth > int.MaxValue || encodedHeight > int.MaxValue)
            {
                throw new CaptureTooLargeException();
            }
            width = (int)encodedWidth;
            height = (int)encodedHeight;
            EnsureDimensions(width, height);
        }

        private static void GetDibDimensions(byte[] dib, out int width, out int height)
        {
            if (dib == null || dib.Length < 12)
            {
                throw new InvalidDataException();
            }
            uint headerSizeValue = ReadUInt32LittleEndian(dib, 0);
            if (headerSizeValue == 12)
            {
                width = ReadUInt16LittleEndian(dib, 4);
                height = ReadUInt16LittleEndian(dib, 6);
            }
            else
            {
                if (headerSizeValue < 40 || headerSizeValue > int.MaxValue || headerSizeValue > dib.Length)
                {
                    throw new InvalidDataException();
                }
                width = ReadInt32LittleEndian(dib, 4);
                int signedHeight = ReadInt32LittleEndian(dib, 8);
                if (signedHeight == int.MinValue)
                {
                    throw new CaptureTooLargeException();
                }
                height = Math.Abs(signedHeight);
            }
            EnsureDimensions(width, height);
        }

        private static PngData ValidatePng(byte[] bytes)
        {
            if (bytes == null || bytes.Length < 33)
            {
                throw new InvalidDataException();
            }
            for (int index = 0; index < PngSignature.Length; index++)
            {
                if (bytes[index] != PngSignature[index])
                {
                    throw new InvalidDataException();
                }
            }
            if (ReadUInt32BigEndian(bytes, 8) != 13
                || bytes[12] != (byte)'I'
                || bytes[13] != (byte)'H'
                || bytes[14] != (byte)'D'
                || bytes[15] != (byte)'R')
            {
                throw new InvalidDataException();
            }

            uint encodedWidth = ReadUInt32BigEndian(bytes, 16);
            uint encodedHeight = ReadUInt32BigEndian(bytes, 20);
            if (encodedWidth > int.MaxValue || encodedHeight > int.MaxValue)
            {
                throw new CaptureTooLargeException();
            }
            int width = (int)encodedWidth;
            int height = (int)encodedHeight;
            EnsureDimensions(width, height);

            using (MemoryStream stream = new MemoryStream(bytes, false))
            using (Image decoded = Image.FromStream(stream, true, true))
            {
                if (decoded.RawFormat.Guid != ImageFormat.Png.Guid
                    || decoded.Width != width
                    || decoded.Height != height)
                {
                    throw new InvalidDataException();
                }

                using (Bitmap forcedDecode = new Bitmap(decoded))
                {
                    if (forcedDecode.Width != width || forcedDecode.Height != height)
                    {
                        throw new InvalidDataException();
                    }
                }
            }

            return new PngData(bytes, width, height);
        }

        private static PngData ConvertDib(byte[] dib, int maxPngBytes)
        {
            byte[] bitmapFile = BuildBitmapFile(dib);
            using (MemoryStream stream = new MemoryStream(bitmapFile, false))
            using (Image decoded = Image.FromStream(stream, true, true))
            {
                EnsureDimensions(decoded.Width, decoded.Height);
                using (Bitmap owned = new Bitmap(
                    decoded.Width,
                    decoded.Height,
                    PixelFormat.Format32bppArgb))
                {
                    using (Graphics graphics = Graphics.FromImage(owned))
                    {
                        graphics.Clear(Color.Transparent);
                        graphics.DrawImageUnscaled(decoded, 0, 0);
                    }
                    return EncodeBitmap(owned, maxPngBytes);
                }
            }
        }

        private static PngData EncodeBitmap(Bitmap bitmap, int maxPngBytes)
        {
            if (bitmap == null)
            {
                throw new InvalidDataException();
            }
            EnsureDimensions(bitmap.Width, bitmap.Height);

            using (BoundedMemoryStream stream = new BoundedMemoryStream(maxPngBytes))
            {
                try
                {
                    bitmap.Save(stream, ImageFormat.Png);
                }
                catch
                {
                    if (stream.LimitExceeded)
                    {
                        throw new CaptureTooLargeException();
                    }
                    throw;
                }
                return new PngData(stream.ToArray(), bitmap.Width, bitmap.Height);
            }
        }

        private static byte[] BuildBitmapFile(byte[] dib)
        {
            if (dib == null || dib.Length < 12)
            {
                throw new InvalidDataException();
            }

            uint headerSizeValue = ReadUInt32LittleEndian(dib, 0);
            if (headerSizeValue > int.MaxValue)
            {
                throw new CaptureTooLargeException();
            }
            int headerSize = (int)headerSizeValue;
            if (headerSize < 12 || headerSize > dib.Length)
            {
                throw new InvalidDataException();
            }

            int pixelOffset;
            long pixelDataEnd;
            if (headerSize == 12)
            {
                int width = ReadUInt16LittleEndian(dib, 4);
                int height = ReadUInt16LittleEndian(dib, 6);
                int planes = ReadUInt16LittleEndian(dib, 8);
                int bitsPerPixel = ReadUInt16LittleEndian(dib, 10);
                if (planes != 1 || !IsSupportedBitDepth(bitsPerPixel))
                {
                    throw new InvalidDataException();
                }
                EnsureDimensions(width, height);
                int colors = bitsPerPixel <= 8 ? 1 << bitsPerPixel : 0;
                pixelOffset = CheckedAdd(headerSize, CheckedMultiply(colors, 3));
                pixelDataEnd = ValidateUncompressedPixels(
                    dib.Length,
                    pixelOffset,
                    width,
                    height,
                    bitsPerPixel);
            }
            else
            {
                if (headerSize < 40)
                {
                    throw new InvalidDataException();
                }

                int width = ReadInt32LittleEndian(dib, 4);
                int signedHeight = ReadInt32LittleEndian(dib, 8);
                int planes = ReadUInt16LittleEndian(dib, 12);
                int bitsPerPixel = ReadUInt16LittleEndian(dib, 14);
                uint compression = ReadUInt32LittleEndian(dib, 16);
                if (planes != 1 || width <= 0 || signedHeight == 0 || !IsSupportedBitDepth(bitsPerPixel))
                {
                    throw new InvalidDataException();
                }
                ValidateCompression(compression, bitsPerPixel);
                if (signedHeight < 0 && compression != 0 && compression != 3 && compression != 6)
                {
                    throw new InvalidDataException();
                }
                long absoluteHeight = signedHeight < 0 ? -(long)signedHeight : signedHeight;
                if (absoluteHeight > int.MaxValue)
                {
                    throw new CaptureTooLargeException();
                }
                EnsureDimensions(width, (int)absoluteHeight);

                int maskBytes = 0;
                if (headerSize == 40 && compression == 3)
                {
                    maskBytes = 12;
                }
                else if (headerSize == 40 && compression == 6)
                {
                    maskBytes = 16;
                }

                uint colorsUsedValue = ReadUInt32LittleEndian(dib, 32);
                long defaultColors = bitsPerPixel <= 8 ? 1L << bitsPerPixel : 0;
                long colors = colorsUsedValue == 0 ? defaultColors : colorsUsedValue;
                if (colors > int.MaxValue)
                {
                    throw new CaptureTooLargeException();
                }
                pixelOffset = CheckedAdd(
                    CheckedAdd(headerSize, maskBytes),
                    CheckedMultiply((int)colors, 4));

                if (compression == 0 || compression == 3 || compression == 6)
                {
                    pixelDataEnd = ValidateUncompressedPixels(
                        dib.Length,
                        pixelOffset,
                        width,
                        (int)absoluteHeight,
                        bitsPerPixel);
                }
                else
                {
                    uint imageSize = ReadUInt32LittleEndian(dib, 20);
                    ulong end = (ulong)pixelOffset + imageSize;
                    if (imageSize == 0 || pixelOffset > dib.Length || end > (ulong)dib.Length)
                    {
                        throw new InvalidDataException();
                    }
                    pixelDataEnd = (long)end;
                }

                if (headerSize >= 124)
                {
                    uint colorSpaceType = ReadUInt32LittleEndian(dib, 56);
                    uint profileOffset = ReadUInt32LittleEndian(dib, 112);
                    uint profileSize = ReadUInt32LittleEndian(dib, 116);
                    if (colorSpaceType == 0x4c494e4b)
                    {
                        throw new InvalidDataException();
                    }
                    if ((profileOffset == 0) != (profileSize == 0))
                    {
                        throw new InvalidDataException();
                    }
                    if (profileSize != 0)
                    {
                        ulong profileEnd = (ulong)profileOffset + profileSize;
                        if (profileOffset < (ulong)pixelDataEnd || profileEnd > (ulong)dib.Length)
                        {
                            throw new InvalidDataException();
                        }
                    }
                }
            }

            if (pixelOffset < headerSize || pixelOffset > dib.Length)
            {
                throw new InvalidDataException();
            }

            int fileLength = CheckedAdd(14, dib.Length);
            int filePixelOffset = CheckedAdd(14, pixelOffset);
            byte[] bitmapFile = new byte[fileLength];
            bitmapFile[0] = (byte)'B';
            bitmapFile[1] = (byte)'M';
            WriteUInt32LittleEndian(bitmapFile, 2, (uint)fileLength);
            WriteUInt32LittleEndian(bitmapFile, 10, (uint)filePixelOffset);
            Buffer.BlockCopy(dib, 0, bitmapFile, 14, dib.Length);
            return bitmapFile;
        }

        private static long ValidateUncompressedPixels(
            int totalLength,
            int pixelOffset,
            int width,
            int height,
            int bitsPerPixel)
        {
            try
            {
                long rowBits = checked((long)width * bitsPerPixel);
                long stride = checked(((rowBits + 31L) / 32L) * 4L);
                long required = checked(stride * height);
                long end = checked((long)pixelOffset + required);
                if (pixelOffset < 0 || end > totalLength)
                {
                    throw new InvalidDataException();
                }
                return end;
            }
            catch (OverflowException)
            {
                throw new CaptureTooLargeException();
            }
        }

        private static void ValidateCompression(uint compression, int bitsPerPixel)
        {
            if (compression == 0)
            {
                return;
            }
            if (compression == 1 && bitsPerPixel == 8)
            {
                return;
            }
            if (compression == 2 && bitsPerPixel == 4)
            {
                return;
            }
            if ((compression == 3 || compression == 6)
                && (bitsPerPixel == 16 || bitsPerPixel == 32))
            {
                return;
            }
            throw new InvalidDataException();
        }

        private static bool IsSupportedBitDepth(int bitsPerPixel)
        {
            return bitsPerPixel == 1
                || bitsPerPixel == 4
                || bitsPerPixel == 8
                || bitsPerPixel == 16
                || bitsPerPixel == 24
                || bitsPerPixel == 32;
        }

        private static bool DimensionsAreValid(int width, int height)
        {
            return width > 0
                && height > 0
                && width <= MaxImageDimension
                && height <= MaxImageDimension
                && (long)width * height <= MaxImagePixels;
        }

        private static void EnsureDimensions(int width, int height)
        {
            if (width <= 0 || height <= 0)
            {
                throw new InvalidDataException();
            }
            if (!DimensionsAreValid(width, height))
            {
                throw new CaptureTooLargeException();
            }
        }

        private static int CheckedAdd(int left, int right)
        {
            try
            {
                return checked(left + right);
            }
            catch (OverflowException)
            {
                throw new CaptureTooLargeException();
            }
        }

        private static int CheckedMultiply(int left, int right)
        {
            try
            {
                return checked(left * right);
            }
            catch (OverflowException)
            {
                throw new CaptureTooLargeException();
            }
        }

        private static int ReadUInt16LittleEndian(byte[] bytes, int offset)
        {
            if (offset < 0 || offset > bytes.Length - 2)
            {
                throw new InvalidDataException();
            }
            return bytes[offset] | (bytes[offset + 1] << 8);
        }

        private static uint ReadUInt32LittleEndian(byte[] bytes, int offset)
        {
            if (offset < 0 || offset > bytes.Length - 4)
            {
                throw new InvalidDataException();
            }
            return (uint)(bytes[offset]
                | (bytes[offset + 1] << 8)
                | (bytes[offset + 2] << 16)
                | (bytes[offset + 3] << 24));
        }

        private static int ReadInt32LittleEndian(byte[] bytes, int offset)
        {
            return unchecked((int)ReadUInt32LittleEndian(bytes, offset));
        }

        private static uint ReadUInt32BigEndian(byte[] bytes, int offset)
        {
            if (offset < 0 || offset > bytes.Length - 4)
            {
                throw new InvalidDataException();
            }
            return ((uint)bytes[offset] << 24)
                | ((uint)bytes[offset + 1] << 16)
                | ((uint)bytes[offset + 2] << 8)
                | bytes[offset + 3];
        }

        private static void WriteUInt32LittleEndian(byte[] bytes, int offset, uint value)
        {
            if (offset < 0 || offset > bytes.Length - 4)
            {
                throw new InvalidDataException();
            }
            bytes[offset] = (byte)value;
            bytes[offset + 1] = (byte)(value >> 8);
            bytes[offset + 2] = (byte)(value >> 16);
            bytes[offset + 3] = (byte)(value >> 24);
        }

        private static void MergeError(ref string current, string incoming)
        {
            if (current == null || incoming == "too-large")
            {
                current = incoming;
            }
        }

        private enum CopyStatus
        {
            Success,
            Invalid,
            TooLarge
        }

        private sealed class PngData
        {
            internal PngData(byte[] bytes, int width, int height)
            {
                Bytes = bytes;
                Width = width;
                Height = height;
            }

            internal byte[] Bytes { get; private set; }
            internal int Width { get; private set; }
            internal int Height { get; private set; }
        }

        private sealed class CaptureTooLargeException : Exception
        {
        }
    }
}
