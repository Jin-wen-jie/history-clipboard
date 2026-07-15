using System;
using System.Runtime.InteropServices;

namespace HistoryClipboard.ClipboardListener
{
    internal static class NativeMethods
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct BitmapObject
        {
            internal int Type;
            internal int Width;
            internal int Height;
            internal int WidthBytes;
            internal ushort Planes;
            internal ushort BitsPixel;
            internal IntPtr Bits;
        }

        internal const int WM_CLIPBOARDUPDATE = 0x031D;
        internal const int WM_APP = 0x8000;
        internal const int WM_AGENT_SHUTDOWN = WM_APP + 0x41;

        internal const uint CF_BITMAP = 2;
        internal const uint CF_DIB = 8;
        internal const uint CF_UNICODETEXT = 13;
        internal const uint CF_HDROP = 15;
        internal const uint CF_DIBV5 = 17;

        internal static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);

        [DllImport("user32.dll", ExactSpelling = true, SetLastError = true,
            CallingConvention = CallingConvention.Winapi)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool AddClipboardFormatListener(IntPtr windowHandle);

        [DllImport("user32.dll", ExactSpelling = true, SetLastError = true,
            CallingConvention = CallingConvention.Winapi)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool RemoveClipboardFormatListener(IntPtr windowHandle);

        [DllImport("user32.dll", ExactSpelling = true, SetLastError = true,
            CallingConvention = CallingConvention.Winapi)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool OpenClipboard(IntPtr ownerWindowHandle);

        [DllImport("user32.dll", ExactSpelling = true, SetLastError = true,
            CallingConvention = CallingConvention.Winapi)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseClipboard();

        [DllImport("user32.dll", ExactSpelling = true, SetLastError = true,
            CallingConvention = CallingConvention.Winapi)]
        internal static extern IntPtr GetClipboardData(uint format);

        [DllImport("user32.dll", ExactSpelling = true, SetLastError = true,
            CallingConvention = CallingConvention.Winapi)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool IsClipboardFormatAvailable(uint format);

        [DllImport("user32.dll", ExactSpelling = true, CallingConvention = CallingConvention.Winapi)]
        internal static extern uint GetClipboardSequenceNumber();

        [DllImport("user32.dll", EntryPoint = "RegisterClipboardFormatW", CharSet = CharSet.Unicode,
            ExactSpelling = true, SetLastError = true, CallingConvention = CallingConvention.Winapi)]
        internal static extern uint RegisterClipboardFormat(string formatName);

        [DllImport("user32.dll", EntryPoint = "PostMessageW", SetLastError = true,
            ExactSpelling = true, CallingConvention = CallingConvention.Winapi)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool PostMessage(
            IntPtr windowHandle,
            uint message,
            UIntPtr wordParameter,
            IntPtr longParameter);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true,
            CallingConvention = CallingConvention.Winapi)]
        internal static extern IntPtr GlobalLock(IntPtr memoryHandle);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true,
            CallingConvention = CallingConvention.Winapi)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GlobalUnlock(IntPtr memoryHandle);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true,
            CallingConvention = CallingConvention.Winapi)]
        internal static extern UIntPtr GlobalSize(IntPtr memoryHandle);

        [DllImport("gdi32.dll", EntryPoint = "GetObjectW", ExactSpelling = true,
            SetLastError = true, CallingConvention = CallingConvention.Winapi)]
        internal static extern int GetObject(
            IntPtr graphicsObject,
            int bufferSize,
            out BitmapObject bitmapObject);

        [DllImport("shell32.dll", EntryPoint = "DragQueryFileW", CharSet = CharSet.Unicode,
            ExactSpelling = true, CallingConvention = CallingConvention.Winapi)]
        internal static extern uint DragQueryFile(
            IntPtr dropHandle,
            uint fileIndex,
            [Out] System.Text.StringBuilder fileName,
            uint fileNameSize);
    }
}
