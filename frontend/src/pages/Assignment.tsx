import { Card, Typography, Form, Input, Button, Space, Descriptions, Tag, InputNumber, message, List, Avatar, Modal, Row, Col, Radio, Checkbox, Alert, Select, Progress } from 'antd';
import { ArrowLeftOutlined, EditOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { assignmentApi } from '@/api/assignment';
import { Assignment, AssignmentType, SubmissionStatus, AssignmentSubmission, ChoiceQuestion, ChoiceQuestionOption } from '@/types/assignment';
import { useAuthStore } from '@/store/auth';
import { UserRole } from '@/types/user';

const { Title, Paragraph, Text } = Typography;

type ChoiceAnswers = Record<string, string | number | Array<string | number>>;

function normalizeOptions(options: ChoiceQuestionOption[] | string[] | undefined): { label: string; value: string }[] {
  if (!Array.isArray(options)) return [];
  return options.map((option) => {
    if (typeof option === 'string' || typeof option === 'number') {
      return { label: String(option), value: String(option) };
    }
    const value = option.value !== undefined ? String(option.value) : option.label || '';
    return { label: option.label || value, value };
  });
}

function getQuestionTitle(question: ChoiceQuestion, index: number) {
  return question.title || question.question || `第 ${index + 1} 题`;
}

export default function AssignmentPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [submission, setSubmission] = useState<AssignmentSubmission | null>(null);
  const [submissions, setSubmissions] = useState<AssignmentSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [rejectReason, setRejectReason] = useState<string>('');
  const [form] = Form.useForm();
  const { user } = useAuthStore();

  const isTeacher = user?.role === UserRole.TEACHER;

  const questions: ChoiceQuestion[] = Array.isArray(assignment?.questions) ? assignment!.questions : [];

  const isDeadlinePassed = !!assignment?.deadline && new Date(assignment.deadline).getTime() <= Date.now();

  useEffect(() => {
    if (id) {
      loadAssignment();
    }
  }, [id]);

  const loadAssignment = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await assignmentApi.get(id);
      setAssignment(data);

      if (isTeacher) {
        const subs = await assignmentApi.getSubmissions(id);
        setSubmissions(subs);
      } else {
        const mySub = await assignmentApi.getMySubmission(id);
        setSubmission(mySub);
        setRejectReason(mySub?.lastRejectReason || '');
        if (mySub) {
          form.setFieldsValue({
            textAnswer: mySub.textAnswer,
            choiceAnswers: mySub.choiceAnswers || {},
            attachmentUrls: mySub.attachmentUrls || [],
          });
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    if (!id || !assignment) return;
    if (isDeadlinePassed) {
      message.error('作业已截止，不能新增或修改提交');
      return;
    }

    let payload: Partial<AssignmentSubmission>;
    if (assignment.type === AssignmentType.TEXT) {
      payload = { textAnswer: values.textAnswer };
    } else if (assignment.type === AssignmentType.CHOICE) {
      payload = { choiceAnswers: values.choiceAnswers };
    } else {
      payload = { attachmentUrls: values.attachmentUrls || [] };
    }

    try {
      const result = await assignmentApi.submit(id, payload);
      setSubmission(result);
      setRejectReason('');
      message.success(submission ? '提交已更新' : '提交成功');
    } catch (error: any) {
      const reason = error.response?.data?.message || '提交失败，已保留原提交内容';
      setRejectReason(Array.isArray(reason) ? reason.join('；') : reason);
      message.error('提交被拒绝，已保留原提交');
      // 刷新以拿到服务端记录的拒绝原因，同时保留表单中的作答
      const mySub = await assignmentApi.getMySubmission(id);
      if (mySub) setSubmission(mySub);
    }
  };

  const renderAnswers = (sub: AssignmentSubmission) => {
    if (sub.textAnswer) {
      return <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{sub.textAnswer}</Paragraph>;
    }
    if (sub.choiceAnswers && Object.keys(sub.choiceAnswers).length > 0) {
      return (
        <div>
          {questions.map((question, index) => {
            const answer = sub.choiceAnswers?.[String(question.id)];
            const text = Array.isArray(answer) ? answer.join('、') : answer;
            return (
              <Paragraph key={String(question.id ?? index)}>
                {getQuestionTitle(question, index)}：{text === undefined || text === '' ? '未作答' : String(text)}
              </Paragraph>
            );
          })}
        </div>
      );
    }
    if (sub.attachmentUrls && sub.attachmentUrls.length > 0) {
      return (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {sub.attachmentUrls.map((url) => (
            <li key={url}>
              <a href={url} target="_blank" rel="noreferrer">{url}</a>
            </li>
          ))}
        </ul>
      );
    }
    return <Paragraph type="secondary">无作答内容</Paragraph>;
  };

  const handleGrade = (sub: AssignmentSubmission) => {
    let score = 85;
    let feedback = '做得很好！';
    Modal.confirm({
      title: '批改作业',
      width: 600,
      content: (
        <div style={{ marginTop: 16 }}>
          <Paragraph strong>学生答案：</Paragraph>
          {renderAnswers(sub)}
          <Paragraph strong style={{ marginTop: 16 }}>得分（0-{assignment?.maxScore ?? 100}）：</Paragraph>
          <InputNumber min={0} max={assignment?.maxScore ?? 100} defaultValue={score} onChange={(v) => (score = v ?? 0)} />
          <Paragraph strong style={{ marginTop: 16 }}>教师反馈：</Paragraph>
          <Input.TextArea rows={3} defaultValue={feedback} onChange={(e) => (feedback = e.target.value)} />
        </div>
      ),
      okText: '批改',
      onOk: async () => {
        try {
          await assignmentApi.grade(sub.id, score, feedback);
          message.success('批改完成');
          loadAssignment();
        } catch (error: any) {
          message.error('批改失败');
        }
      },
    });
  };

  const getTypeText = (type: AssignmentType) => {
    switch (type) {
      case AssignmentType.TEXT:
        return '文本题';
      case AssignmentType.CHOICE:
        return '选择题';
      case AssignmentType.ATTACHMENT:
        return '附件提交';
    }
  };

  const getStatusTag = (status: SubmissionStatus) => {
    switch (status) {
      case SubmissionStatus.SUBMITTED:
        return <Tag color="blue">待批改</Tag>;
      case SubmissionStatus.GRADED:
        return <Tag color="green">已批改</Tag>;
    }
  };

  /** 计算已有提交的作答完整度（0-100）与说明 */
  const getCompleteness = (sub: AssignmentSubmission | null): { percent: number; text: string } => {
    if (!sub) return { percent: 0, text: '未提交' };
    if (assignment?.type === AssignmentType.TEXT) {
      return sub.textAnswer && sub.textAnswer.trim()
        ? { percent: 100, text: '作答完整（文字答案已填写）' }
        : { percent: 0, text: '作答不完整（缺少文字答案）' };
    }
    if (assignment?.type === AssignmentType.CHOICE) {
      const total = questions.length;
      if (total === 0) return { percent: 100, text: '作答完整' };
      const answered = questions.filter((q) => {
        const answer = sub.choiceAnswers?.[String(q.id)];
        return Array.isArray(answer) ? answer.length > 0 : answer !== undefined && answer !== null && answer !== '';
      }).length;
      const percent = Math.round((answered / total) * 100);
      return { percent, text: `已作答 ${answered} / ${total} 题` };
    }
    const count = sub.attachmentUrls?.length || 0;
    return count > 0
      ? { percent: 100, text: `作答完整（${count} 个附件）` }
      : { percent: 0, text: '作答不完整（缺少附件）' };
  };

  if (loading) {
    return <Card><div style={{ textAlign: 'center', padding: 50 }}>加载中...</div></Card>;
  }

  if (!assignment) {
    return <Card><div style={{ textAlign: 'center', padding: 50 }}>作业不存在</div></Card>;
  }

  const completeness = getCompleteness(submission);

  return (
    <div>
      <Space style={{ marginBottom: 24 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>
          返回
        </Button>
        <Title level={3} style={{ margin: 0 }}>
          {assignment.title}
        </Title>
        <Tag>{getTypeText(assignment.type)}</Tag>
        {assignment.deadline && (
          <Tag color={isDeadlinePassed ? 'red' : 'green'}>
            {isDeadlinePassed ? '已截止' : '进行中'}（{new Date(assignment.deadline).toLocaleString()} 截止）
          </Tag>
        )}
      </Space>

      <Row gutter={24}>
        <Col span={16}>
          <Card title="作业详情">
            <Descriptions column={1}>
              <Descriptions.Item label="作业说明">
                <Paragraph>{assignment.description}</Paragraph>
              </Descriptions.Item>
              <Descriptions.Item label="满分">
                {assignment.maxScore} 分
              </Descriptions.Item>
              {assignment.deadline && (
                <Descriptions.Item label="截止时间">
                  {new Date(assignment.deadline).toLocaleString()}
                  {isDeadlinePassed && <Tag color="red" style={{ marginLeft: 8 }}>已截止</Tag>}
                </Descriptions.Item>
              )}
            </Descriptions>
          </Card>

          {!isTeacher && (
            <Card title="我的答案" style={{ marginTop: 24 }}>
              <Space style={{ marginBottom: 16 }}>
                {submission && getStatusTag(submission.status)}
                <Text type="secondary">作答完整度：</Text>
                <Progress percent={completeness.percent} size="small" style={{ width: 160, marginBottom: 0 }} />
                <Text type="secondary">{completeness.text}</Text>
              </Space>

              {submission && (
                <Paragraph type="secondary">
                  最近提交时间：{new Date(submission.updatedAt || submission.createdAt).toLocaleString()}
                </Paragraph>
              )}

              {rejectReason && (
                <Alert
                  type="error"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="提交被拒绝"
                  description={`原因：${rejectReason}。原提交内容已保留，可修改后重新提交。`}
                />
              )}

              {isDeadlinePassed && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="作业已截止"
                  description={submission ? '截止后不能新增或修改提交，以下为此前提交的内容。' : '截止后不能再提交作业。'}
                />
              )}

              {submission?.status === SubmissionStatus.GRADED && (
                <div style={{ marginBottom: 16, padding: 16, background: '#f5f5f5', borderRadius: 8 }}>
                  <Paragraph strong>得分：{submission.score} / {assignment.maxScore}</Paragraph>
                  <Paragraph strong>教师反馈：</Paragraph>
                  <Paragraph>{submission.feedback}</Paragraph>
                </div>
              )}

              <Form
                form={form}
                layout="vertical"
                onFinish={handleSubmit}
                style={{ marginTop: 16 }}
                disabled={isDeadlinePassed}
              >
                {assignment.type === AssignmentType.TEXT && (
                  <Form.Item name="textAnswer" label="答案" rules={[{ required: true, whitespace: true, message: '请输入文字答案' }]}>
                    <Input.TextArea rows={8} placeholder="请输入你的答案" />
                  </Form.Item>
                )}

                {assignment.type === AssignmentType.CHOICE && (
                  <Form.Item label="选择题（所有题目均为必答）">
                    <Space direction="vertical" style={{ width: '100%' }} size={20}>
                      {questions.map((question, qIndex) => {
                        const options = normalizeOptions(question.options);
                        const name = ['choiceAnswers', String(question.id)];
                        return (
                          <div key={String(question.id ?? qIndex)}>
                            <Paragraph strong>
                              {qIndex + 1}. {getQuestionTitle(question, qIndex)}
                              {question.multiple && <Tag color="purple" style={{ marginLeft: 8 }}>多选</Tag>}
                            </Paragraph>
                            <Form.Item
                              name={name}
                              rules={[{ required: true, message: `请作答：${getQuestionTitle(question, qIndex)}` }]}
                              style={{ marginBottom: 0 }}
                            >
                              {question.multiple ? (
                                <Checkbox.Group options={options} />
                              ) : (
                                <Radio.Group options={options} />
                              )}
                            </Form.Item>
                          </div>
                        );
                      })}
                    </Space>
                  </Form.Item>
                )}

                {assignment.type === AssignmentType.ATTACHMENT && (
                  <Form.Item
                    name="attachmentUrls"
                    label="附件链接"
                    extra="粘贴附件链接后回车添加，至少上传一个附件"
                    rules={[
                      {
                        validator: (_, value) =>
                          Array.isArray(value) && value.length > 0
                            ? Promise.resolve()
                            : Promise.reject(new Error('请至少添加一个附件链接')),
                      },
                    ]}
                  >
                    <Select mode="tags" placeholder="输入附件链接后回车" tokenSeparators={[',']} />
                  </Form.Item>
                )}

                {!isDeadlinePassed && (
                  <Form.Item>
                    <Space>
                      <Button type="primary" htmlType="submit" size="large">
                        {submission ? '更新提交' : '提交作业'}
                      </Button>
                      {submission && <Text type="secondary">重复提交只会更新你本人的内容，不会产生新的提交记录</Text>}
                    </Space>
                  </Form.Item>
                )}
              </Form>
            </Card>
          )}

          {isTeacher && (
            <Card title="学生提交" style={{ marginTop: 24 }}>
              <List
                dataSource={submissions}
                locale={{ emptyText: '暂无提交' }}
                renderItem={(sub) => (
                  <List.Item
                    actions={[
                      sub.status === SubmissionStatus.SUBMITTED && (
                        <Button type="primary" icon={<EditOutlined />} onClick={() => handleGrade(sub)}>
                          批改
                        </Button>
                      ),
                    ]}
                  >
                    <List.Item.Meta
                      avatar={<Avatar>{sub.student?.name?.[0] || sub.studentId?.[0] || 'U'}</Avatar>}
                      title={
                        <Space>
                          {sub.student?.name || sub.studentId || '未知用户'}
                          {getStatusTag(sub.status)}
                        </Space>
                      }
                      description={
                        <Space>
                          <span>提交时间：{new Date(sub.createdAt).toLocaleString()}</span>
                          {sub.score !== null && sub.score !== undefined && <span>得分：{sub.score}</span>}
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
            </Card>
          )}
        </Col>
      </Row>
    </div>
  );
}
