import { useCallback } from 'react';
import { readUiScale, viewportPxToApp } from '../utils/uiScale';
import { clampStudioBottomHeight, clampStudioChatWidth } from '../utils/studioLayout';

// Hook that provides mouse-drag resizing for the sidebar, chat panel, and bottom panel.
export function useResizing({
  setSidebarWidth,
  setChatWidth,
  setBottomPanelHeight,
  sidebarWidth,
  chatWidth,
  bottomPanelHeight,
  studioChatWidth,
  setStudioChatWidth,
  studioBottomHeight,
  setStudioBottomHeight,
}) {
  const startResizing = useCallback((mouseDownEvent, direction) => {
    mouseDownEvent.preventDefault();
    const startX = mouseDownEvent.clientX;
    const startY = mouseDownEvent.clientY;
    const startWidthLeft = sidebarWidth;
    const startWidthRight = chatWidth;
    const startHeightBottom = bottomPanelHeight;
    const startStudioChatWidth = studioChatWidth;
    const startStudioBottomHeight = studioBottomHeight;
    // The panel sizes are CSS lengths inside the zoomed app, but the pointer
    // travel is measured in viewport pixels. Without this the panel edge lags
    // behind the cursor by exactly the interface scale. Read once per drag
    // rather than per move — the scale cannot change mid-gesture.
    const scale = readUiScale();

    const handleMouseMove = (mouseMoveEvent) => {
      if (direction === 'left') {
        const deltaX = viewportPxToApp(mouseMoveEvent.clientX - startX, scale);
        const newWidth = Math.max(150, Math.min(600, startWidthLeft + deltaX));
        setSidebarWidth(newWidth);
      } else if (direction === 'right') {
        const deltaX = viewportPxToApp(mouseMoveEvent.clientX - startX, scale);
        const newWidth = Math.max(200, Math.min(900, startWidthRight - deltaX));
        setChatWidth(newWidth);
      } else if (direction === 'bottom') {
        const deltaY = viewportPxToApp(mouseMoveEvent.clientY - startY, scale);
        const newHeight = Math.max(100, Math.min(600, startHeightBottom - deltaY));
        setBottomPanelHeight(newHeight);
      } else if (direction === 'studio-chat') {
        // In the studio layout the chat is docked to the *left* of its handle,
        // so dragging right widens it — the opposite sign from the IDE's
        // right-docked chat above.
        const deltaX = viewportPxToApp(mouseMoveEvent.clientX - startX, scale);
        setStudioChatWidth(clampStudioChatWidth(startStudioChatWidth + deltaX));
      } else if (direction === 'studio-bottom') {
        const deltaY = viewportPxToApp(mouseMoveEvent.clientY - startY, scale);
        const available = viewportPxToApp(window.innerHeight, scale);
        setStudioBottomHeight(clampStudioBottomHeight(startStudioBottomHeight - deltaY, available));
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [
    sidebarWidth,
    chatWidth,
    bottomPanelHeight,
    studioChatWidth,
    studioBottomHeight,
    setSidebarWidth,
    setChatWidth,
    setBottomPanelHeight,
    setStudioChatWidth,
    setStudioBottomHeight,
  ]);

  return { startResizing };
}
