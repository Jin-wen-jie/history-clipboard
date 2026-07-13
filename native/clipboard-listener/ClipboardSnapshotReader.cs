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
            if (bitmap == null)
            {
                throw new ArgumentNullException("bitmap");
            }
            long storedBytes = checked((long)bitmap.Width * bitmap.Height * 4L);
            return new CapturedImageCandidate(
                CapturedImageCandidateKind.Bitmap,
                null,
                bitmap,
                storedBytes,
                null);
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
            if (Bitmap != null)
            {
                Bitmap.Dispose();
                Bitmap = null;
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

    internal sealed class ClipboardSnapshotReader
    {
        private const int OpenTimeoutMilliseconds = 1000;
        private const int OpenRetryDelayMilliseconds = 10;
        private const int MaxClipboardBytes = AgentProtocol.MaxFrameLength;
        private const int MaxImageDimension = 32768;
        private const long MaxImagePixels = 16L * 1024L * 1024L;
        private const long EstimatedPngOverheadBytes = 64L * 1024L;
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

            long reservedBytes = 0;
            try
            {
                using (Bitmap clipboardBitmap = Image.FromHbitmap(handle))
                {
                    if (!DimensionsAreValid(clipboardBitmap.Width, clipboardBitmap.Height))
                    {
                        candidates.Add(CapturedImageCandidate.Failure(
                            CapturedImageCandidateKind.Bitmap,
                            "too-large"));
                        return;
                    }

                    reservedBytes = checked(
                        (long)clipboardBitmap.Width * clipboardBitmap.Height * 4L);
                    if (!budget.TryReserve(reservedBytes))
                    {
                        candidates.Add(CapturedImageCandidate.Failure(
                            CapturedImageCandidateKind.Bitmap,
                            "too-large"));
                        reservedBytes = 0;
                        return;
                    }

                    Bitmap owned = new Bitmap(
                        clipboardBitmap.Width,
                        clipboardBitmap.Height,
                        PixelFormat.Format32bppArgb);
                    try
                    {
                        using (Graphics graphics = Graphics.FromImage(owned))
                        {
                            graphics.Clear(Color.Transparent);
                            graphics.DrawImageUnscaled(clipboardBitmap, 0, 0);
                        }
                        candidates.Add(CapturedImageCandidate.FromBitmap(owned));
                        owned = null;
                        reservedBytes = 0;
                        return;
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
            catch (OutOfMemoryException)
            {
                if (reservedBytes != 0)
                {
                    budget.Release(reservedBytes);
                }
                candidates.Add(CapturedImageCandidate.Failure(
                    CapturedImageCandidateKind.Bitmap,
                    "too-large"));
            }
            catch
            {
                if (reservedBytes != 0)
                {
                    budget.Release(reservedBytes);
                }
                candidates.Add(CapturedImageCandidate.Failure(
                    CapturedImageCandidateKind.Bitmap,
                    "internal"));
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
                            png = ConvertDib(candidate.Bytes);
                        }
                        else
                        {
                            png = EncodeBitmap(candidate.Bitmap);
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
                    }
                    catch
                    {
                        MergeError(ref errorCode, "internal");
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
                for (int index = 0; index < candidates.Count; index++)
                {
                    if (candidates[index] != null)
                    {
                        candidates[index].Dispose();
                    }
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
                long estimatedPngBytes = checked(pixelBytes + EstimatedPngOverheadBytes);
                if (kind == CapturedImageCandidateKind.Png)
                {
                    return checked(retainedCandidateBytes + checked(pixelBytes * 2L));
                }
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

        private static PngData ConvertDib(byte[] dib)
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
                    return EncodeBitmap(owned);
                }
            }
        }

        private static PngData EncodeBitmap(Bitmap bitmap)
        {
            if (bitmap == null)
            {
                throw new InvalidDataException();
            }
            EnsureDimensions(bitmap.Width, bitmap.Height);

            using (MemoryStream stream = new MemoryStream())
            {
                bitmap.Save(stream, ImageFormat.Png);
                if (stream.Length > MaxClipboardBytes)
                {
                    throw new CaptureTooLargeException();
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
