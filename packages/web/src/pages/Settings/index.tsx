import { deviceRoute, moduleRoute, radioRoute } from "@app/routes";
import { toBinary, create } from "@bufbuild/protobuf";
import { PageLayout } from "@components/PageLayout.tsx";
import { Sidebar } from "@components/Sidebar.tsx";
import { SidebarButton } from "@components/UI/Sidebar/SidebarButton.tsx";
import { SidebarSection } from "@components/UI/Sidebar/SidebarSection.tsx";
import { useToast } from "@core/hooks/useToast.ts";
import { useDevice, useNodeDB } from "@core/stores";
import { cn } from "@core/utils/cn.ts";
import { Protobuf } from "@meshtastic/core";
import { DeviceConfig } from "@pages/Settings/DeviceConfig.tsx";
import { ModuleConfig } from "@pages/Settings/ModuleConfig.tsx";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  LayersIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  RouterIcon,
  SaveIcon,
  SaveOff,
  NetworkIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FieldValues, UseFormReturn } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { RadioConfig } from "./RadioConfig.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@components/UI/Select.tsx";
import { Button } from "@components/UI/Button.tsx";
import { numberToHexUnpadded } from "@noble/curves/abstract/utils";

const ConfigPage = () => {
  const {
    getAllConfigChanges,
    getAllModuleConfigChanges,
    getAllChannelChanges,
    getAllQueuedAdminMessages,
    connection,
    clearAllChanges,
    setConfig,
    setModuleConfig,
    addChannel,
    getConfigChangeCount,
    getModuleConfigChangeCount,
    getChannelChangeCount,
    getAdminMessageChangeCount,
    setRemoteAdminTarget,
    getRemoteAdminTarget,
    hardware,
  } = useDevice();
  
  const { getNodes } = useNodeDB();

  const [isSaving, setIsSaving] = useState(false);
  const [rhfState, setRhfState] = useState({ isDirty: false, isValid: true });
  const unsubRef = useRef<(() => void) | null>(null);
  const [formMethods, setFormMethods] = useState<UseFormReturn | null>(null);
  const { toast } = useToast();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const { t } = useTranslation("config");

  const configChangeCount = getConfigChangeCount();
  const moduleConfigChangeCount = getModuleConfigChangeCount();
  const channelChangeCount = getChannelChangeCount();
  const adminMessageChangeCount = getAdminMessageChangeCount();

  const sections = useMemo(
    () => [
      {
        key: "radio",
        route: radioRoute,
        label: t("navigation.radioConfig"),
        icon: RadioTowerIcon,
        changeCount: configChangeCount,
        component: RadioConfig,
      },
      {
        key: "device",
        route: deviceRoute,
        label: t("navigation.deviceConfig"),
        icon: RouterIcon,
        changeCount: moduleConfigChangeCount,
        component: DeviceConfig,
      },
      {
        key: "module",
        route: moduleRoute,
        label: t("navigation.moduleConfig"),
        icon: LayersIcon,
        changeCount: channelChangeCount,
        component: ModuleConfig,
      },
    ],
    [t, configChangeCount, moduleConfigChangeCount, channelChangeCount],
  );

  const activeSection =
    sections.find((section) =>
      routerState.location.pathname.includes(`/settings/${section.key}`),
    ) ?? sections[0];

  const onFormInit = useCallback(
    <T extends FieldValues>(methods: UseFormReturn<T>) => {
      setFormMethods(methods as UseFormReturn);

      setRhfState({
        // Assume defailt on init, changes will be caught by subscription
        isDirty: false,
        isValid: true,
      });

      // Unsubscribe from previous subscriptions & subscribe to form changes
      unsubRef.current?.();
      unsubRef.current = methods.subscribe({
        formState: { isDirty: true, isValid: true },
        callback: ({ isValid, isDirty }) => {
          setRhfState({
            isDirty: isDirty ?? false,
            isValid: isValid ?? true,
          });
        },
      });
    },
    [],
  );

  useEffect(() => {
    return () => unsubRef.current?.();
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);

    try {
      const channelChanges = getAllChannelChanges();
      const configChanges = getAllConfigChanges();
      const moduleConfigChanges = getAllModuleConfigChanges();
      const adminMessages = getAllQueuedAdminMessages();
      const remoteTarget = getRemoteAdminTarget();
      const isRemoteAdmin = remoteTarget !== null;

      // For remote admin, convert config/module config changes to admin messages
      const remoteAdminMessages: Protobuf.Admin.AdminMessage[] = [];
      
      if (isRemoteAdmin) {
        // Convert config changes to admin messages
        configChanges.forEach((newConfig) => {
          const adminMessage = create(Protobuf.Admin.AdminMessageSchema, {
            payloadVariant: {
              case: "setConfig",
              value: newConfig,
            },
          });
          remoteAdminMessages.push(adminMessage);
        });

        // Convert module config changes to admin messages
        moduleConfigChanges.forEach((newModuleConfig) => {
          const adminMessage = create(Protobuf.Admin.AdminMessageSchema, {
            payloadVariant: {
              case: "setModuleConfig",
              value: newModuleConfig,
            },
          });
          remoteAdminMessages.push(adminMessage);
        });

        // Convert channel changes to admin messages
        channelChanges.forEach((channel) => {
          const adminMessage = create(Protobuf.Admin.AdminMessageSchema, {
            payloadVariant: {
              case: "setChannel",
              value: channel,
            },
          });
          remoteAdminMessages.push(adminMessage);
        });
      }

      // Send all admin messages (queued + converted) to remote node if in remote admin mode
      const allAdminMessages = [...adminMessages, ...remoteAdminMessages];
      
      if (isRemoteAdmin && allAdminMessages.length > 0) {
        await Promise.all(
          allAdminMessages.map((message) =>
            connection?.sendPacket(
              toBinary(Protobuf.Admin.AdminMessageSchema, message),
              Protobuf.Portnums.PortNum.ADMIN_APP,
              remoteTarget,
            ),
          ),
        );
        
        toast({
          title: t("toast.saveAllSuccess.title"),
          description: t("toast.saveAllSuccess.description"),
        });
      } else {
        // Local admin mode - use existing methods
        await Promise.all(
          channelChanges.map((channel) =>
            connection?.setChannel(channel).then(() => {
              toast({
                title: t("toast.savedChannel.title", {
                  ns: "ui",
                  channelName: channel.settings?.name,
                }),
              });
            }),
          ),
        );

        await Promise.all(
          configChanges.map((newConfig) =>
            connection?.setConfig(newConfig).then(() => {
              toast({
                title: t("toast.saveSuccess.title"),
                description: t("toast.saveSuccess.description", {
                  case: newConfig.payloadVariant.case,
                }),
              });
            }),
          ),
        );

        await Promise.all(
          moduleConfigChanges.map((newModuleConfig) =>
            connection?.setModuleConfig(newModuleConfig).then(() =>
              toast({
                title: t("toast.saveSuccess.title"),
                description: t("toast.saveSuccess.description", {
                  case: newModuleConfig.payloadVariant.case,
                }),
              }),
            ),
          ),
        );

        if (configChanges.length > 0 || moduleConfigChanges.length > 0) {
          await connection?.commitEditSettings();
        }

        // Send queued admin messages for local admin
        if (adminMessages.length > 0) {
          await Promise.all(
            adminMessages.map((message) =>
              connection?.sendPacket(
                toBinary(Protobuf.Admin.AdminMessageSchema, message),
                Protobuf.Portnums.PortNum.ADMIN_APP,
                "self",
              ),
            ),
          );
        }
      }

      // Only update local store if not in remote admin mode
      if (!isRemoteAdmin) {
        channelChanges.forEach((newChannel) => {
          addChannel(newChannel);
        });
        configChanges.forEach((newConfig) => {
          setConfig(newConfig);
        });
        moduleConfigChanges.forEach((newModuleConfig) => {
          setModuleConfig(newModuleConfig);
        });
      }

      clearAllChanges();

      if (formMethods) {
        formMethods.reset(formMethods.getValues(), {
          keepDirty: false,
          keepErrors: false,
          keepTouched: false,
          keepValues: true,
        });

        formMethods.trigger();
      }
    } catch (_error) {
      toast({
        title: t("toast.configSaveError.title"),
        description: t("toast.configSaveError.description"),
      });
    } finally {
      setIsSaving(false);
      toast({
        title: t("toast.saveAllSuccess.title"),
        description: t("toast.saveAllSuccess.description"),
      });
    }
  }, [
    toast,
    t,
    getAllConfigChanges,
    connection,
    getAllModuleConfigChanges,
    getAllChannelChanges,
    getAllQueuedAdminMessages,
    formMethods,
    addChannel,
    setConfig,
    setModuleConfig,
    clearAllChanges,
    getRemoteAdminTarget,
  ]);

  const handleReset = useCallback(() => {
    if (formMethods) {
      formMethods.reset();
    }
    clearAllChanges();
  }, [formMethods, clearAllChanges]);

  const leftSidebar = useMemo(
    () => (
      <Sidebar>
        <SidebarSection label={t("sidebar.label")} className="py-2 px-0">
          {sections.map((section) => (
            <SidebarButton
              key={section.key}
              label={section.label}
              active={activeSection?.key === section.key}
              onClick={() => navigate({ to: section.route.to })}
              Icon={section.icon}
              isDirty={section.changeCount > 0}
              count={section.changeCount}
            />
          ))}
        </SidebarSection>
      </Sidebar>
    ),
    [sections, activeSection?.key, navigate, t],
  );

  const hasDrafts =
    getConfigChangeCount() > 0 ||
    getModuleConfigChangeCount() > 0 ||
    getChannelChangeCount() > 0 ||
    adminMessageChangeCount > 0;
  const hasPending = hasDrafts || rhfState.isDirty;
  const buttonOpacity = hasPending ? "opacity-100" : "opacity-0";
  const saveDisabled = isSaving || !rhfState.isValid || !hasPending;

  const actions = useMemo(
    () => [
      {
        key: "unsavedChanges",
        label: t("common:formValidation.unsavedChanges"),
        onClick: () => {},
        className: cn([
          "bg-blue-500 text-slate-900 hover:bg-initial",
          "transition-colors duration-200",
          buttonOpacity,
          "transition-opacity",
        ]),
      },
      {
        key: "reset",
        icon: RefreshCwIcon,
        label: t("common:button.reset"),
        onClick: handleReset,
        className: cn([
          buttonOpacity,
          "transition-opacity hover:bg-slate-200 disabled:hover:bg-white",
          "hover:dark:bg-slate-300  hover:dark:text-black cursor-pointer",
        ]),
      },
      {
        key: "save",
        icon: !hasPending ? SaveOff : SaveIcon,
        isLoading: isSaving,
        disabled: saveDisabled,
        iconClasses:
          !rhfState.isValid && hasPending
            ? "text-red-400 cursor-not-allowed"
            : "cursor-pointer",
        className: cn([
          "transition-opacity hover:bg-slate-200 disabled:hover:bg-white",
          "hover:dark:bg-slate-300 hover:dark:text-black",
          "disabled:hover:cursor-not-allowed cursor-pointer",
        ]),
        onClick: handleSave,
        label: t("common:button.save"),
      },
    ],
    [
      isSaving,
      hasPending,
      rhfState.isValid,
      saveDisabled,
      buttonOpacity,
      handleReset,
      handleSave,
      t,
    ],
  );

  const ActiveComponent = activeSection?.component;
  
  const remoteAdminTarget = getRemoteAdminTarget();
  const nodes = getNodes();
  const availableNodes = nodes.filter(
    (node) => node.num !== hardware.myNodeNum,
  );

  const handleRemoteNodeChange = useCallback(
    (nodeNum: string) => {
      if (nodeNum === "local") {
        setRemoteAdminTarget(null);
      } else {
        setRemoteAdminTarget(Number.parseInt(nodeNum, 10));
      }
    },
    [setRemoteAdminTarget],
  );

  const selectedNode = remoteAdminTarget
    ? nodes.find((node) => node.num === remoteAdminTarget)
    : null;

  return (
    <PageLayout
      contentClassName="overflow-auto"
      leftBar={leftSidebar}
      label={activeSection?.label ?? ""}
      actions={actions}
    >
      <div className="mb-4 p-4 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <NetworkIcon className="h-5 w-5" />
            <label className="text-sm font-medium">
              {t("remoteAdmin.label")}:
            </label>
          </div>
          <Select
            value={remoteAdminTarget?.toString() ?? "local"}
            onValueChange={handleRemoteNodeChange}
          >
            <SelectTrigger className="w-64">
              <SelectValue placeholder={t("remoteAdmin.selectNode")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">
                {t("remoteAdmin.localDevice")} ({hardware.myNodeNum})
              </SelectItem>
              {availableNodes.length > 0 && (
                <>
                  {availableNodes.map((node) => {
                    const shortName =
                      node.user?.shortName ??
                      numberToHexUnpadded(node.num).slice(-4).toUpperCase();
                    const longName =
                      node.user?.longName ??
                      t("remoteAdmin.node", {
                        shortName,
                        nodeNum: node.num,
                      });
                    return (
                      <SelectItem key={node.num} value={node.num.toString()}>
                        {longName} (!{numberToHexUnpadded(node.num)})
                      </SelectItem>
                    );
                  })}
                </>
              )}
            </SelectContent>
          </Select>
          {selectedNode && (
            <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
              <span>{t("remoteAdmin.administering")}:</span>
              <span className="font-medium">
                {selectedNode.user?.longName ??
                  selectedNode.user?.shortName ??
                  `Node ${selectedNode.num}`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRemoteAdminTarget(null)}
                className="h-6 w-6 p-0"
              >
                <XIcon className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
        {remoteAdminTarget && (
          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {t("remoteAdmin.warning")}
          </div>
        )}
      </div>
      {ActiveComponent && <ActiveComponent onFormInit={onFormInit} />}
    </PageLayout>
  );
};

export default ConfigPage;
